import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTheFinder,
  type EntryChange,
  type ImageProcessor,
  type StorageDriver,
  type TheFinder,
  type TheFinderOptions,
  type VolumeOptions,
} from "../src/index";
import { localDriver } from "../src/drivers/local";
import { s3Driver } from "../src/drivers/s3";
import { fakeS3 } from "./fake-s3";
import { api, bytes, id, tempDir } from "./helpers";

const MiB = 1024 * 1024;
const DAY = 86_400_000;

/** Stand-in image processor: every output is three bytes, so nothing is ever "larger". */
const images: ImageProcessor = {
  extensions: ["png", "jpg"],
  formats: ["png", "jpeg", "webp"],
  transform: async () => ({ data: new Uint8Array([1, 2, 3]), width: 1, height: 1 }),
};

const s3 = () => s3Driver({ bucket: "bucket", endpoint: "http://s3.test", accessKeyId: "k", secretAccessKey: "s", fetch: fakeS3("bucket").fetch });

/** Each driver with the smallest chunk size it accepts (local: several chunks per upload). */
const drivers: [string, (dir: string) => StorageDriver, number][] = [
  ["local", (dir) => localDriver({ root: dir }), 1024],
  ["s3", () => s3(), 5 * MiB],
];

type Call = { changes: EntryChange[]; cmd: string | null };

describe.each(drivers)("onEntriesChanged (%s)", (V, makeDriver, chunkSize) => {
  let cleanup: () => Promise<void>;
  let driver: StorageDriver;
  let calls: Call[];
  let a: ReturnType<typeof api>;
  const at = (path: string) => id(V, path);

  const make = (volume: Partial<VolumeOptions> = {}, options: Partial<TheFinderOptions> = {}): TheFinder =>
    createTheFinder({
      volumes: [{ id: V, driver, ...volume }],
      chunkSize,
      images,
      onEntriesChanged: (changes, ctx) => {
        calls.push({ changes, cmd: ctx?.cmd ?? null });
      },
      ...options,
    });

  /** Runs `fn` and returns the changes it reported; fails if the hook ran more than once. */
  const changesOf = async (fn: () => Promise<unknown>): Promise<EntryChange[]> => {
    calls = [];
    await fn();
    expect(calls.length).toBeLessThanOrEqual(1);
    return calls[0]?.changes ?? [];
  };

  beforeEach(async () => {
    let dir: string;
    ({ dir, cleanup } = await tempDir());
    driver = makeDriver(dir);
    calls = [];
    a = api(make());
    await a.ok("mkdir", { id: at("/"), name: "Belgeler" });
    await a.ok("mkdir", { id: at("/Belgeler"), name: "2026" });
    await a.ok("mkfile", { id: at("/Belgeler"), name: "rapor.txt", content: "rapor" });
    await a.ok("mkfile", { id: at("/Belgeler/2026"), name: "a.txt", content: "a" });
    await a.ok("mkfile", { id: at("/"), name: "not.txt", content: "not" });
    await a.ok("mkfile", { id: at("/"), name: "foto.png", content: "a png bigger than three bytes" });
    await a.ok("mkdir", { id: at("/"), name: "Hedef" });
    calls = [];
  });
  afterEach(() => cleanup());

  const file = (path: string) => ({ volume: V, path });

  describe("moves", () => {
    it("rename reports a move", async () => {
      expect(await changesOf(() => a.ok("rename", { id: at("/not.txt"), name: "yeni.txt" }))).toEqual([
        { type: "moved", from: file("/not.txt"), to: file("/yeni.txt"), kind: "file" },
      ]);
    });

    it("a folder is one event, its contents are not listed", async () => {
      expect(await changesOf(() => a.ok("rename", { id: at("/Belgeler"), name: "Arşiv" }))).toEqual([
        { type: "moved", from: file("/Belgeler"), to: file("/Arşiv"), kind: "dir" },
      ]);
      expect(await changesOf(() => a.ok("paste", { ids: [at("/Arşiv")], dst: at("/Hedef"), cut: true }))).toEqual([
        { type: "moved", from: file("/Arşiv"), to: file("/Hedef/Arşiv"), kind: "dir" },
      ]);
    });

    it("cut-paste reports the name it was actually given on a clash", async () => {
      await a.ok("mkfile", { id: at("/Hedef"), name: "not.txt", content: "başka" });
      const changes = await changesOf(() => a.ok("paste", { ids: [at("/not.txt")], dst: at("/Hedef"), cut: true }));
      expect(changes).toEqual([{ type: "moved", from: file("/not.txt"), to: file("/Hedef/not (2).txt"), kind: "file" }]);
    });

    it("copying without a clash, or cut-pasting into the same folder, reports nothing", async () => {
      expect(await changesOf(() => a.ok("paste", { ids: [at("/not.txt"), at("/Belgeler")], dst: at("/Hedef") }))).toEqual([]);
      expect(await changesOf(() => a.ok("paste", { ids: [at("/not.txt")], dst: at("/"), cut: true }))).toEqual([]);
    });

    it("copying over a file replaces it", async () => {
      await a.ok("mkfile", { id: at("/Hedef"), name: "not.txt", content: "eski" });
      expect(await changesOf(() => a.ok("paste", { ids: [at("/not.txt")], dst: at("/Hedef"), conflict: "overwrite" }))).toEqual([
        { type: "replaced", volume: V, path: "/Hedef/not.txt" },
      ]);
    });

    it("moving over a file replaces it, then moves", async () => {
      await a.ok("mkfile", { id: at("/Hedef"), name: "not.txt", content: "eski" });
      expect(await changesOf(() => a.ok("paste", { ids: [at("/not.txt")], dst: at("/Hedef"), cut: true, conflict: "overwrite" }))).toEqual([
        { type: "replaced", volume: V, path: "/Hedef/not.txt" },
        { type: "moved", from: file("/not.txt"), to: file("/Hedef/not.txt"), kind: "file" },
      ]);
    });

    it("moving over a folder deletes the folder that was there", async () => {
      await a.ok("mkdir", { id: at("/Hedef"), name: "Belgeler" });
      await a.ok("mkfile", { id: at("/Hedef/Belgeler"), name: "eski.txt", content: "eski" });
      expect(await changesOf(() => a.ok("paste", { ids: [at("/Belgeler")], dst: at("/Hedef"), cut: true, conflict: "overwrite" }))).toEqual([
        { type: "deleted", volume: V, path: "/Hedef/Belgeler", kind: "dir" },
        { type: "moved", from: file("/Belgeler"), to: file("/Hedef/Belgeler"), kind: "dir" },
      ]);
    });
  });

  describe("trash", () => {
    it("keeps the same trashId from trashed to restored and purged", async () => {
      const removed = await changesOf(() => a.ok("rm", { ids: [at("/not.txt"), at("/Belgeler")] }));
      const { entries } = await a.ok("trash");
      const tid = (name: string) => entries.find((e: any) => e.name === name).trash.id as string;
      expect(removed).toEqual([
        { type: "trashed", volume: V, path: "/not.txt", kind: "file", trashId: tid("not.txt") },
        { type: "trashed", volume: V, path: "/Belgeler", kind: "dir", trashId: tid("Belgeler") },
      ]);
      expect(await changesOf(() => a.ok("restore", { ids: [entries.find((e: any) => e.name === "Belgeler").id] }))).toEqual([
        { type: "restored", volume: V, trashId: tid("Belgeler"), path: "/Belgeler", kind: "dir" },
      ]);
      expect(await changesOf(() => a.ok("purge", { ids: [entries.find((e: any) => e.name === "not.txt").id] }))).toEqual([
        { type: "purged", volume: V, trashId: tid("not.txt") },
      ]);
    });

    it("reports the path a restore actually went back to", async () => {
      const { trashed } = await a.ok("rm", { ids: [at("/not.txt")] });
      await a.ok("mkfile", { id: at("/"), name: "not.txt", content: "yeni" });
      expect(await changesOf(() => a.ok("restore", { ids: [trashed[0].id] }))).toEqual([
        { type: "restored", volume: V, trashId: trashed[0].trash.id, path: "/not (2).txt", kind: "file" },
      ]);
    });

    it("permanent deletion, or a volume without trash, reports deleted", async () => {
      expect(await changesOf(() => a.ok("rm", { ids: [at("/not.txt")], permanent: true }))).toEqual([
        { type: "deleted", volume: V, path: "/not.txt", kind: "file" },
      ]);
      const plain = api(make({ trash: false }));
      expect(await changesOf(() => plain.ok("rm", { ids: [at("/Belgeler")] }))).toEqual([{ type: "deleted", volume: V, path: "/Belgeler", kind: "dir" }]);
    });

    it("emptying the trash purges every item", async () => {
      const { trashed } = await a.ok("rm", { ids: [at("/not.txt"), at("/Belgeler")] });
      const changes = await changesOf(() => a.ok("purge", { all: true }));
      expect(changes.map((c) => (c.type === "purged" ? c.trashId : "")).sort()).toEqual(trashed.map((e: any) => e.trash.id).sort());
      expect(changes.every((c) => c.type === "purged" && c.volume === V)).toBe(true);
    });

    it("items past the retention period are reported as purged by the command that cleans them up", async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 31 * DAY);
      const { trashed } = await a.ok("rm", { ids: [at("/not.txt")] });
      clock.mockRestore();
      const kept = (await a.ok("rm", { ids: [at("/foto.png")] })).trashed[0];

      calls = [];
      const { entries } = await a.ok("trash");
      expect(entries.map((e: any) => e.trash.id)).toEqual([kept.trash.id]);
      expect(calls).toEqual([{ cmd: "trash", changes: [{ type: "purged", volume: V, trashId: trashed[0].trash.id }] }]);
      // Nothing left to clean up: no second report.
      expect(await changesOf(() => a.ok("trash"))).toEqual([]);
    });
  });

  describe("replacing content", () => {
    it("upload over an existing file replaces it; with a new name it reports nothing", async () => {
      const data = bytes(3000);
      expect(await changesOf(() => a.upload(at("/"), "not.txt", data, chunkSize, { conflict: "overwrite" }))).toEqual([
        { type: "replaced", volume: V, path: "/not.txt" },
      ]);
      expect(await changesOf(() => a.upload(at("/"), "not.txt", data, chunkSize))).toEqual([]);
      expect(await changesOf(() => a.upload(at("/"), "yeni.txt", data, chunkSize, { conflict: "overwrite" }))).toEqual([]);
    });

    it("put on a file replaces it; saving a copy reports nothing", async () => {
      expect(await changesOf(() => a.ok("put", { id: at("/not.txt"), content: "v2" }))).toEqual([{ type: "replaced", volume: V, path: "/not.txt" }]);
      expect(await changesOf(() => a.ok("put", { dst: at("/"), name: "not.txt", content: "kopya" }))).toEqual([]);
    });

    it("revert replaces the file; bringing back a removed file reports nothing", async () => {
      await a.ok("put", { id: at("/not.txt"), content: "v2" });
      const { versions } = await a.ok("versions", { id: at("/not.txt") });
      expect(await changesOf(() => a.ok("revert", { id: at("/not.txt"), vid: versions[0].id }))).toEqual([{ type: "replaced", volume: V, path: "/not.txt" }]);
      await a.ok("rm", { ids: [at("/not.txt")] });
      expect(await changesOf(() => a.ok("revert", { id: at("/not.txt"), vid: versions[0].id }))).toEqual([]);
    });

    it("transform in place replaces the file; a converted copy reports nothing unless it overwrites one", async () => {
      // Every output is three bytes: keep it even when not smaller.
      const foto = [at("/foto.png")];
      const t = (extra: Record<string, unknown>) => a.ok("transform", { ids: foto, skipLarger: false, ...extra });
      expect(await changesOf(() => t({}))).toEqual([{ type: "replaced", volume: V, path: "/foto.png" }]);
      expect(await changesOf(() => t({ dryRun: true }))).toEqual([]);
      expect(await changesOf(() => t({ format: "webp" }))).toEqual([]);
      expect(await changesOf(() => t({ format: "webp", conflict: "overwrite" }))).toEqual([{ type: "replaced", volume: V, path: "/foto.webp" }]);
      expect(await changesOf(() => t({ output: "copy", conflict: "overwrite" }))).toEqual([]);
    });
  });

  it("creating new entries reports nothing", async () => {
    await a.ok("mkdir", { id: at("/"), name: "Yeni" });
    await a.ok("mkfile", { id: at("/"), name: "yeni.txt", content: "" });
    await a.ok("duplicate", { ids: [at("/not.txt"), at("/Belgeler")] });
    const { entry } = await a.ok("archive", { ids: [at("/Belgeler")] });
    await a.ok("extract", { id: entry.id });
    await a.upload(at("/"), "yükleme.txt", bytes(10), chunkSize);
    expect(calls).toEqual([]);
  });

  describe("partial failure", () => {
    it("reports what was done before a command failed, then fails as usual", async () => {
      const code = await a.fail("paste", { ids: [at("/not.txt"), at("/yok.txt"), at("/foto.png")], dst: at("/Hedef"), cut: true });
      expect(code).toBe("NOT_FOUND");
      expect(calls).toEqual([{ cmd: "paste", changes: [{ type: "moved", from: file("/not.txt"), to: file("/Hedef/not.txt"), kind: "file" }] }]);
      expect((await a.ok("ls", { id: at("/") })).entries.map((e: any) => e.name)).toContain("foto.png");
    });

    it("a failure before any change reports nothing", async () => {
      expect(await a.fail("rm", { ids: [at("/yok.txt"), at("/not.txt")] })).toBe("NOT_FOUND");
      expect(calls).toEqual([]);
    });
  });

  describe("hook contract", () => {
    it("is awaited before onAfterCommand and gets the command context", async () => {
      const order: string[] = [];
      const f = make(
        {},
        {
          onEntriesChanged: async (_, ctx) => {
            await new Promise((r) => setTimeout(r, 10));
            order.push(`changes:${ctx?.cmd}`);
          },
          onAfterCommand: ({ cmd }) => {
            order.push(`after:${cmd}`);
          },
        },
      );
      await api(f).ok("rename", { id: at("/not.txt"), name: "yeni.txt" });
      await api(f).ok("ls", { id: at("/") });
      expect(order).toEqual(["changes:rename", "after:rename", "after:ls"]);
    });

    it("a throwing hook fails the request like onAfterCommand, though the change is done", async () => {
      const after = vi.fn();
      const f = make({}, { onEntriesChanged: () => Promise.reject(new Error("db down")), onAfterCommand: after });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await api(f).post("rename", { id: at("/not.txt"), name: "yeni.txt" });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL");
      expect(after).not.toHaveBeenCalled();
      expect((await a.ok("ls", { id: at("/") })).entries.map((e: any) => e.name)).toContain("yeni.txt");
      // When the command itself failed, its own error is returned and the hook error is logged.
      expect(await api(f).fail("rm", { ids: [at("/yeni.txt"), at("/yok.txt")] })).toBe("NOT_FOUND");
      expect(errors).toHaveBeenCalledWith("[thefinder] onEntriesChanged", expect.any(Error));
      errors.mockRestore();
    });

    it("runs for execute() and never for a read-only view", async () => {
      const f = make({}, { authorize: ({ request }) => (request.headers.get("x-role") === "viewer" ? { readOnly: true } : true) });
      await f.execute("rename", { id: at("/not.txt"), name: "yeni.txt" });
      expect(calls).toEqual([{ cmd: "rename", changes: [{ type: "moved", from: file("/not.txt"), to: file("/yeni.txt"), kind: "file" }] }]);
      calls = [];
      expect(await api(f, "viewer").fail("rm", { ids: [at("/yeni.txt")] })).toBe("READ_ONLY");
      expect(calls).toEqual([]);
    });
  });
});

describe("onEntriesChanged across volumes", () => {
  it("reports a cut-paste from one volume to another as a single move", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const calls: EntryChange[][] = [];
      const a = api(
        createTheFinder({
          volumes: [
            { id: "local", driver: localDriver({ root: dir }) },
            { id: "s3", driver: s3() },
          ],
          chunkSize: 5 * MiB,
          onEntriesChanged: (changes) => {
            calls.push(changes);
          },
        }),
      );
      await a.ok("mkdir", { id: id("local", "/"), name: "Belgeler" });
      await a.ok("mkfile", { id: id("local", "/Belgeler"), name: "a.txt", content: "a" });
      await a.ok("mkfile", { id: id("local", "/"), name: "not.txt", content: "not" });
      await a.ok("mkfile", { id: id("s3", "/"), name: "not.txt", content: "orada" });
      await a.ok("paste", { ids: [id("local", "/Belgeler"), id("local", "/not.txt")], dst: id("s3", "/"), cut: true });
      expect(calls).toEqual([
        [
          { type: "moved", from: { volume: "local", path: "/Belgeler" }, to: { volume: "s3", path: "/Belgeler" }, kind: "dir" },
          { type: "moved", from: { volume: "local", path: "/not.txt" }, to: { volume: "s3", path: "/not (2).txt" }, kind: "file" },
        ],
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("without onEntriesChanged", () => {
  /** The same commands on a fresh tree; returns every response with times and trash ids blanked out. */
  async function scenario(hook: TheFinderOptions["onEntriesChanged"]) {
    const { dir, cleanup } = await tempDir();
    try {
      const a = api(createTheFinder({ volumes: [{ id: "local", driver: localDriver({ root: dir }) }], chunkSize: 1024, images, onEntriesChanged: hook }));
      const at = (path: string) => id("local", path);
      const out: unknown[] = [];
      const run = async (cmd: string, body: Record<string, unknown>) => out.push((await a.post(cmd, body)).body);
      await run("mkdir", { id: at("/"), name: "Belgeler" });
      await run("mkfile", { id: at("/"), name: "not.txt", content: "not" });
      await run("mkfile", { id: at("/Belgeler"), name: "not.txt", content: "eski" });
      await run("mkfile", { id: at("/"), name: "foto.png", content: "a png bigger than three bytes" });
      await run("rename", { id: at("/not.txt"), name: "yeni.txt" });
      await run("paste", { ids: [at("/yeni.txt")], dst: at("/Belgeler") });
      await run("paste", { ids: [at("/Belgeler/not.txt")], dst: at("/"), cut: true, conflict: "overwrite" });
      await run("paste", { ids: [at("/yeni.txt"), at("/yok.txt")], dst: at("/Belgeler"), cut: true });
      await run("put", { id: at("/not.txt"), content: "v2" });
      await run("transform", { ids: [at("/foto.png")] });
      await run("rm", { ids: [at("/not.txt")] });
      await run("rm", { ids: [at("/foto.png")], permanent: true });
      await run("trash", {});
      await run("purge", { all: true });
      out.push(await a.upload(at("/"), "b.txt", bytes(3000), 1024, { conflict: "overwrite" }));
      out.push(await a.upload(at("/"), "b.txt", bytes(3000), 1024, { conflict: "overwrite" }));
      return JSON.parse(JSON.stringify(out, (k, v) => (k === "mtime" || k === "deletedAt" ? 0 : k === "id" || k === "removed" ? typeof v : v)));
    } finally {
      await cleanup();
    }
  }

  it("every command behaves exactly as with the hook", async () => {
    const hook = vi.fn();
    const withHook = await scenario(hook);
    expect(hook).toHaveBeenCalled();
    expect(await scenario(undefined)).toEqual(withHook);
  });
});
