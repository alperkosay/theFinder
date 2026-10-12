import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient, type TheFinderClient, type Entry } from "@thefinder/core/client";
import { TheFinder, type TheFinderProps } from "./TheFinder";
import { useMovable } from "./movable";
import { mountWindow, type FinderWindowOptions } from "./popup";

/** A chosen file, with a URL ready to put in a form field, an `<img src>` or an editor. */
export interface PickedFile extends Entry {
  /** Public URL when the volume has one ("/uploads/a.png"), otherwise the API's file URL. */
  url: string;
}

export interface FilePickerOptions extends Omit<TheFinderProps, "onSelect" | "onCancel" | "height" | "style" | "persistKey"> {
  /** Return absolute URLs ("https://site/uploads/a.png") instead of server-relative ones. Default: false. */
  absoluteUrls?: boolean;
  /** localStorage key for the picker's view preferences. Default: "thefinder-picker". */
  persistKey?: string | false;
  /**
   * Open the picker in its own browser window (like elFinder) instead of a dialog on the page.
   * Falls back to the dialog when the browser blocks the popup. Default: false.
   */
  popup?: boolean | FinderWindowOptions;
}

/** The URL a picked entry is reachable at. */
export function pickedUrl(entry: Entry, client: TheFinderClient, absolute = false): string {
  const url = entry.url ?? client.fileUrl(entry);
  return absolute && typeof location !== "undefined" ? new URL(url, location.href).toString() : url;
}

type PickerProps = Omit<FilePickerOptions, "popup"> & { onDone: (files: PickedFile[] | null) => void };

/** theFinder in picker mode, filling its dialog or window. */
function PickerFinder({ onDone, absoluteUrls, ...props }: PickerProps) {
  // One client for the picker's lifetime (props are fixed while it is open).
  const client = useMemo(
    () => props.client ?? createClient({ endpoint: props.endpoint, headers: props.headers, credentials: props.credentials }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <TheFinder
      persistKey="thefinder-picker"
      {...props}
      client={client}
      height="100%"
      onSelect={(entries) => onDone(entries.map((e) => ({ ...e, url: pickedUrl(e, client, absoluteUrls) })))}
      onCancel={() => onDone(null)}
    />
  );
}

function PickerDialog({ onDone, ...props }: PickerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const done = useRef(false);
  // The header doubles as a title bar.
  const movable = useMovable(ref, ".tf-header");

  const finish = useCallback(
    (files: PickedFile[] | null) => {
      if (done.current) return;
      done.current = true;
      onDone(files);
    },
    [onDone],
  );

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="tf-picker"
      aria-label={props.selectLabel ?? "theFinder"}
      // Escape is handled below so it can first close menus and dialogs inside the file manager.
      onCancel={(e) => e.preventDefault()}
      onClose={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) finish(null);
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) finish(null); // backdrop click
      }}
      onPointerDown={movable.onPointerDown}
      onDoubleClick={movable.onDoubleClick}
    >
      <PickerFinder {...props} onDone={finish} />
    </dialog>
  );
}

/**
 * Opens theFinder as a modal file picker and resolves with the chosen files, or `null` when the
 * user cancels. Works outside React too (vanilla JS, Vue, rich text editors):
 *
 * ```ts
 * const files = await openFilePicker({ endpoint: "/api/files", accept: "image/*" });
 * if (files) input.value = files[0].url;
 * ```
 *
 * Pass `popup: true` to open it in a separate browser window instead.
 */
export function openFilePicker({ popup, ...options }: FilePickerOptions): Promise<PickedFile[] | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    if (popup) {
      let picked: PickedFile[] | null = null;
      const win = mountWindow(
        (close) => (
          <PickerFinder
            {...options}
            onDone={(files) => {
              picked = files;
              close();
            }}
          />
        ),
        popup === true ? {} : popup,
      );
      if (win) {
        void win.closed.then(() => resolve(picked));
        return;
      }
      // Blocked by the browser: the dialog still works.
    }
    const host = document.createElement("div");
    host.className = "tf-picker-host";
    document.body.appendChild(host);
    const root = createRoot(host);
    const onDone = (files: PickedFile[] | null) => {
      resolve(files);
      // Unmount after the current event finishes; React must not unmount a root mid-render.
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(<PickerDialog {...options} onDone={onDone} />);
  });
}

/**
 * React hook around `openFilePicker`.
 *
 * ```tsx
 * const picker = useFilePicker({ endpoint: "/api/files", accept: "image/*" });
 * <button onClick={async () => { const [file] = (await picker.open()) ?? []; if (file) setValue(file.url); }}>
 *   Choose
 * </button>
 * ```
 */
export function useFilePicker(options: FilePickerOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(async (overrides?: Partial<FilePickerOptions>) => {
    setOpen(true);
    try {
      return await openFilePicker({ ...latest.current, ...overrides });
    } finally {
      setOpen(false);
    }
  }, []);
  return { open, isOpen };
}
