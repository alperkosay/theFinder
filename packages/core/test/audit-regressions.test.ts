// Regression tests for the issues found by the run-1 security audit.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTheFinder } from "../src/index";
import { localDriver } from "../src/drivers/local";
import { s3Driver } from "../src/drivers/s3";
import { fakeS3 } from "./fake-s3";
import { api, id, tempDir } from "./helpers";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

const noSecret = (_action: string, path: string) => !(path === "/secret" || path.startsWith("/secret/"));

describe("permission rules hold on every command", () => {
  beforeEach(async () => {
    await mkdir(join(dir, "secret"));
    await writeFile(join(dir, "secret", "report-salaries.txt"), "top secret salaries");
  });

  it("parents refuses paths inside unreadable folders, existing or not", async () => {
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), permission: noSecret }] }));
    expect(await a.fail("parents", { id: id("local", "/secret/report-salaries.txt") })).toBe("FORBIDDEN");
    expect(await a.fail("parents", { id: id("local", "/secret/nope.txt") })).toBe("FORBIDDEN");
    await mkdir(join(dir, "public"));
    const { entries } = await a.ok("parents", { id: id("local", "/public") });
    expect(entries.map((e: { path: string }) => e.path)).toEqual(["/", "/public"]);
  });

  it("stats never names unreadable files", async () => {
    await writeFile(join(dir, "visible.txt"), "visible");
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), permission: noSecret }] }));
    const stats = await a.ok("stats", { volume: "local" });
    expect(JSON.stringify(stats)).not.toContain("report-salaries");
    expect(stats.largest.map((e: { name: string }) => e.name)).toEqual(["visible.txt"]);
  });

  it("upload relativePath needs write access on every folder it goes into", async () => {
    await mkdir(join(dir, "locked"));
    const noWriteLocked = (action: string, path: string) => !(action === "write" && (path === "/locked" || path.startsWith("/locked/")));
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), permission: noWriteLocked }] }));
    const err = await a
      .upload(id("local", "/"), "planted.txt", new TextEncoder().encode("planted"), 1024, { relativePath: "locked/sub" })
      .catch((e: Error) => e.message);
    expect(err).toContain("FORBIDDEN");
    expect(await readdir(join(dir, "locked"))).toEqual([]);
    await a.upload(id("local", "/"), "ok.txt", new TextEncoder().encode("ok"), 1024, { relativePath: "open/sub" });
    expect(await readFile(join(dir, "open", "sub", "ok.txt"), "utf8")).toBe("ok");
  });

  it("paste overwrite cannot delete a folder with delete-protected contents", async () => {
    await mkdir(join(dir, "src", "keep"), { recursive: true });
    await writeFile(join(dir, "src", "keep", "new.txt"), "new");
    await mkdir(join(dir, "dst", "keep"), { recursive: true });
    await writeFile(join(dir, "dst", "keep", "precious.txt"), "precious");
    const protect = (action: string, path: string) => !(action === "delete" && path === "/dst/keep/precious.txt");
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), trash: true, permission: protect }] }));
    expect(await a.fail("paste", { ids: [id("local", "/src/keep")], dst: id("local", "/dst"), conflict: "overwrite" })).toBe("FORBIDDEN");
    expect(await readdir(join(dir, "dst", "keep"))).toEqual(["precious.txt"]);
  });

  it("paste overwrite checks the target name before deleting anything", async () => {
    await mkdir(join(dir, "a", ".tf-versions"), { recursive: true });
    await writeFile(join(dir, "a", ".tf-versions", "x"), "x");
    await mkdir(join(dir, ".tf-versions"), { recursive: true });
    await writeFile(join(dir, ".tf-versions", "keep"), "history");
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), showHidden: true }] }));
    expect(await a.fail("paste", { ids: [id("local", "/a/.tf-versions")], dst: id("local", "/"), conflict: "overwrite" })).not.toBe(undefined);
    expect(await readFile(join(dir, ".tf-versions", "keep"), "utf8")).toBe("history");
  });
});

describe("size limits apply to every write", () => {
  it("put and mkfile respect maxUploadSize", async () => {
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), maxUploadSize: 10 }] }));
    const big = "x".repeat(1000);
    expect(await a.fail("put", { dst: id("local", "/"), name: "p.txt", content: big })).toBe("TOO_LARGE");
    expect(await a.fail("mkfile", { id: id("local", "/"), name: "m.txt", content: big })).toBe("TOO_LARGE");
    await a.ok("put", { dst: id("local", "/"), name: "small.txt", content: "small" });
    expect(await readdir(dir)).toEqual(["small.txt"]);
  });

  it("put and mkfile respect maxEditSize for text", async () => {
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }) }], maxEditSize: 10 }));
    expect(await a.fail("put", { dst: id("local", "/"), name: "p.txt", content: "x".repeat(100) })).toBe("TOO_LARGE");
    expect(await a.fail("mkfile", { id: id("local", "/"), name: "m.txt", content: "x".repeat(100) })).toBe("TOO_LARGE");
  });

  it("an S3 chunked upload must add up to the declared size", async () => {
    const s3 = fakeS3("bucket");
    const finder = createTheFinder({
      volumes: [
        {
          id: "s3",
          driver: s3Driver({ bucket: "bucket", endpoint: "http://s3.test", accessKeyId: "k", secretAccessKey: "s", fetch: s3.fetch }),
          maxUploadSize: 100,
        },
      ],
    });
    let session = "";
    let last: { ok: boolean; data: { session: string }; error?: { code: string; message: string } } | undefined;
    for (let index = 0; index < 3; index++) {
      const form = new FormData();
      for (const [k, v] of Object.entries({ cmd: "upload", dst: id("s3", "/"), name: "big.bin", size: "100", index: String(index), total: "3", offset: "0" }))
        form.set(k, v);
      if (session) form.set("session", session);
      form.set("chunk", new Blob([new Uint8Array(100)]), "big.bin");
      const res = await finder.handler(new Request("http://localhost/api/files", { method: "POST", headers: { "x-thefinder": "1" }, body: form }));
      last = (await res.json()) as typeof last;
      if (!last!.ok) break;
      session = last!.data.session;
    }
    expect(last!.ok).toBe(false);
    expect([...s3.objects.keys()].some((k) => k.endsWith("big.bin"))).toBe(false);
  });

  it("an oversized body is refused before it is read", async () => {
    const finder = createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }) }], maxRequestSize: 1024 * 1024 });
    const enc = new TextEncoder();
    const parts = [
      enc.encode('{"cmd":"mkfile","id":"x","content":"'),
      ...Array.from({ length: 8 }, () => new Uint8Array(1024 * 1024).fill(97)),
      enc.encode('"}'),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const send = async (headers: Record<string, string>) => {
      let pulled = 0;
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < parts.length) {
            pulled += parts[i]!.length;
            c.enqueue(parts[i++]!);
          } else c.close();
        },
      });
      const res = await finder.handler(
        new Request("http://localhost/api/files", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          duplex: "half",
        } as RequestInit),
      );
      return { code: ((await res.json()) as { error: { code: string } }).error.code, pulled };
    };
    const noHeader = await send({});
    expect(noHeader.code).toBe("FORBIDDEN");
    expect(noHeader.pulled).toBeLessThan(total);
    const tooBig = await send({ "x-thefinder": "1" });
    expect(tooBig.code).toBe("TOO_LARGE");
    expect(tooBig.pulled).toBeLessThan(total);
  });
});

it("a renamed file on S3 is served with the type of its current name", async () => {
  const s3 = fakeS3("bucket");
  const a = api(
    createTheFinder({
      volumes: [{ id: "s3", driver: s3Driver({ bucket: "bucket", endpoint: "http://s3.test", accessKeyId: "k", secretAccessKey: "s", fetch: s3.fetch }) }],
    }),
  );
  await a.ok("mkfile", { id: id("s3", "/"), name: "x.html", content: "<script>alert(document.domain)</script>" });
  await a.ok("rename", { id: id("s3", "/x.html"), name: "x.txt" });
  const res = await a.get({ cmd: "file", id: id("s3", "/x.txt") });
  expect(res.status).toBe(302);
  expect(new URL(res.headers.get("location")!).searchParams.get("response-content-type")).toBe("text/plain");
});

describe("names are matched as spelled", () => {
  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "case variants do not reach a protected path on a case-insensitive volume",
    async () => {
      await mkdir(join(dir, "secret"));
      await writeFile(join(dir, "secret", "report-salaries.txt"), "top secret salaries");
      const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }), permission: noSecret }] }));
      expect(await a.fail("get", { id: id("local", "/SECRET/report-salaries.txt") })).not.toBe(undefined);
      expect(await a.fail("mkfile", { id: id("local", "/SECRET"), name: "planted.txt", content: "x" })).not.toBe(undefined);
      expect(await readdir(join(dir, "secret"))).toEqual(["report-salaries.txt"]);
    },
  );

  it("a case-only rename still works", async () => {
    await writeFile(join(dir, "report.txt"), "mine");
    const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }) }] }));
    await a.ok("rename", { id: id("local", "/report.txt"), name: "Report.txt" });
    expect(await readdir(dir)).toEqual(["Report.txt"]);
    expect(await readFile(join(dir, "Report.txt"), "utf8")).toBe("mine");
  });

  it.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "a case-only rename does not replace another file on a case-sensitive volume",
    async () => {
      await writeFile(join(dir, "report.txt"), "mine");
      await writeFile(join(dir, "Report.txt"), "someone else's");
      const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }) }] }));
      expect(await a.fail("rename", { id: id("local", "/report.txt"), name: "Report.txt" })).toBe("EXISTS");
      expect(await readFile(join(dir, "Report.txt"), "utf8")).toBe("someone else's");
    },
  );
});
