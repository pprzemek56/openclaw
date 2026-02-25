import type { CdpSendFn } from "./cdp.helpers.js";
import { withCdpSocket } from "./cdp.helpers.js";
import { getRoleRefsForTarget } from "./pw-session.js";
import type { ClickButton, ClickModifier } from "./routes/agent.act.shared.js";

// ─── Key mapping ────────────────────────────────────────────────────────────

type KeyDef = { key: string; code: string; keyCode: number };

const KEY_MAP: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  " ": { key: " ", code: "Space", keyCode: 32 },
};

function resolveKey(name: string): KeyDef {
  const mapped = KEY_MAP[name];
  if (mapped) {
    return mapped;
  }
  if (name.length === 1) {
    return {
      key: name,
      code: /^[a-zA-Z]$/.test(name) ? `Key${name.toUpperCase()}` : "",
      keyCode: name.toUpperCase().charCodeAt(0),
    };
  }
  return { key: name, code: name, keyCode: 0 };
}

// ─── Modifier bitmask ───────────────────────────────────────────────────────

function modifierBitmask(modifiers?: ClickModifier[]): number {
  if (!modifiers?.length) {
    return 0;
  }
  let mask = 0;
  for (const m of modifiers) {
    switch (m) {
      case "Alt":
        mask |= 1;
        break;
      case "Control":
        mask |= 2;
        break;
      case "Meta":
        mask |= 4;
        break;
      case "Shift":
        mask |= 8;
        break;
      case "ControlOrMeta":
        mask |= process.platform === "darwin" ? 4 : 2;
        break;
    }
  }
  return mask;
}

/**
 * Parse modifier names from the beginning of a Playwright-style key combo
 * (e.g. "Control+Shift+a") and return the modifier bitmask + remaining key name.
 */
function parseKeyCombo(raw: string): { modifiers: number; keyName: string } {
  const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift", "ControlOrMeta"] as const;
  let remaining = raw;
  let modifiers = 0;

  for (;;) {
    let found = false;
    for (const mod of MODIFIER_NAMES) {
      if (remaining.startsWith(mod + "+")) {
        switch (mod) {
          case "Alt":
            modifiers |= 1;
            break;
          case "Control":
            modifiers |= 2;
            break;
          case "Meta":
            modifiers |= 4;
            break;
          case "Shift":
            modifiers |= 8;
            break;
          case "ControlOrMeta":
            modifiers |= process.platform === "darwin" ? 4 : 2;
            break;
        }
        remaining = remaining.slice(mod.length + 1);
        found = true;
        break;
      }
    }
    if (!found) {
      break;
    }
  }

  return { modifiers, keyName: remaining || raw };
}

// ─── Ref resolution internals ───────────────────────────────────────────────

function normalizeRef(ref: string): string {
  if (ref.startsWith("@")) {
    return ref.slice(1);
  }
  if (ref.startsWith("ref=")) {
    return ref.slice(4);
  }
  return ref;
}

type ElementHandle = {
  objectId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

async function getElementRect(send: CdpSendFn, objectId: string): Promise<ElementHandle> {
  const result = (await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }`,
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number; width: number; height: number } } };

  const rect = result?.result?.value;
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    throw new Error("CDP: element has zero bounding rect");
  }
  return { objectId, ...rect };
}

async function scrollIntoViewElement(send: CdpSendFn, objectId: string): Promise<void> {
  await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      if (typeof this.scrollIntoViewIfNeeded === 'function') {
        this.scrollIntoViewIfNeeded(true);
      } else {
        this.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }`,
    awaitPromise: false,
  });
  // Brief pause for scroll to settle before reading new coordinates.
  await new Promise((r) => setTimeout(r, 50));
}

async function resolveRefViaAria(
  send: CdpSendFn,
  normalized: string,
  frameSelector?: string,
): Promise<ElementHandle> {
  if (frameSelector) {
    throw new Error("CDP: frameSelector requires Playwright");
  }
  await send("Runtime.enable");
  const evalResult = (await send("Runtime.evaluate", {
    expression: `document.querySelector('[aria-ref="${normalized}"]')`,
    returnByValue: false,
  })) as { result?: { objectId?: string; subtype?: string } };

  const objectId = evalResult?.result?.objectId;
  if (!objectId || evalResult.result?.subtype === "null") {
    throw new Error(`CDP: aria-ref="${normalized}" not found in DOM`);
  }
  return await getElementRect(send, objectId);
}

async function resolveRefViaRole(
  send: CdpSendFn,
  info: { role: string; name?: string; nth?: number },
  frameSelector?: string,
): Promise<ElementHandle> {
  if (frameSelector) {
    throw new Error("CDP: frameSelector requires Playwright");
  }

  await send("Accessibility.enable");
  const axResult = (await send("Accessibility.getFullAXTree")) as {
    nodes?: Array<{
      role?: { value?: string };
      name?: { value?: string };
      backendDOMNodeId?: number;
    }>;
  };
  const nodes = axResult?.nodes ?? [];

  // Collect all nodes that match {role, name}.
  const matches: number[] = [];
  for (const node of nodes) {
    const role = node.role?.value ?? "";
    const name = node.name?.value ?? "";
    if (role.toLowerCase() !== info.role.toLowerCase()) {
      continue;
    }
    if (info.name !== undefined && name !== info.name) {
      continue;
    }
    if (typeof node.backendDOMNodeId !== "number") {
      continue;
    }
    matches.push(node.backendDOMNodeId);
  }

  const idx = info.nth ?? 0;
  const backendNodeId = matches[idx];
  if (backendNodeId === undefined) {
    throw new Error(
      `CDP: AX match not found for role="${info.role}" name="${info.name ?? ""}" nth=${idx}`,
    );
  }

  await send("DOM.enable");
  const resolved = (await send("DOM.resolveNode", { backendNodeId })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error("CDP: DOM.resolveNode failed");
  }
  return await getElementRect(send, objectId);
}

async function resolveRefToElement(
  send: CdpSendFn,
  ref: string,
  cdpUrl: string,
  targetId: string,
): Promise<ElementHandle> {
  const normalized = normalizeRef(ref);
  if (!/^e\d+$/.test(normalized)) {
    throw new Error(`CDP: unsupported ref format "${normalized}"`);
  }

  const cached = getRoleRefsForTarget({ cdpUrl, targetId });
  if (!cached) {
    throw new Error(
      `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
    );
  }

  if (cached.mode === "aria") {
    return await resolveRefViaAria(send, normalized, cached.frameSelector);
  }

  // "role" mode
  const info = cached.refs[normalized];
  if (!info) {
    throw new Error(
      `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
    );
  }
  return await resolveRefViaRole(send, info, cached.frameSelector);
}

// ─── Click helpers ──────────────────────────────────────────────────────────

async function clickAtPoint(
  send: CdpSendFn,
  x: number,
  y: number,
  opts: { button?: ClickButton; doubleClick?: boolean; modifiers?: number },
): Promise<void> {
  const button = opts.button ?? "left";
  const mods = opts.modifiers ?? 0;

  // Move → press → release
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: mods });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount: 1,
    modifiers: mods,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount: 1,
    modifiers: mods,
  });

  if (opts.doubleClick) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: 2,
      modifiers: mods,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: 2,
      modifiers: mods,
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true when CDP-based interactions should be attempted.
 * Requires a page-level WebSocket URL, loopback CDP, and a non-extension driver.
 */
export function canUseCdpInteractions(opts: {
  wsUrl?: string;
  cdpIsLoopback: boolean;
  driver: string;
}): boolean {
  return Boolean(opts.wsUrl) && opts.cdpIsLoopback && opts.driver !== "extension";
}

/**
 * Returns true for "Unknown ref" errors that should NOT be caught for fallback
 * because Playwright would produce the same error.
 */
export function isRefValidationError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown ref");
}

export async function clickViaCdp(opts: {
  wsUrl: string;
  ref: string;
  cdpUrl: string;
  targetId: string;
  doubleClick?: boolean;
  button?: ClickButton;
  modifiers?: ClickModifier[];
}): Promise<void> {
  await withCdpSocket(opts.wsUrl, async (send) => {
    const elem = await resolveRefToElement(send, opts.ref, opts.cdpUrl, opts.targetId);
    await scrollIntoViewElement(send, elem.objectId);
    // Re-read coordinates after scroll.
    const rect = await getElementRect(send, elem.objectId);
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    await clickAtPoint(send, cx, cy, {
      button: opts.button,
      doubleClick: opts.doubleClick,
      modifiers: modifierBitmask(opts.modifiers),
    });
  });
}

export async function typeViaCdp(opts: {
  wsUrl: string;
  ref: string;
  cdpUrl: string;
  targetId: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
}): Promise<void> {
  await withCdpSocket(opts.wsUrl, async (send) => {
    // Click the element to focus it.
    const elem = await resolveRefToElement(send, opts.ref, opts.cdpUrl, opts.targetId);
    await scrollIntoViewElement(send, elem.objectId);
    const rect = await getElementRect(send, elem.objectId);
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    await clickAtPoint(send, cx, cy, {});
    await new Promise((r) => setTimeout(r, 50));

    // Select all existing text (Ctrl+A) so the new text replaces it.
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
    });

    if (opts.slowly) {
      for (const char of opts.text) {
        const kd = resolveKey(char);
        await send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: kd.key,
          code: kd.code,
          windowsVirtualKeyCode: kd.keyCode,
        });
        if (kd.key.length === 1) {
          await send("Input.dispatchKeyEvent", {
            type: "char",
            key: kd.key,
            text: kd.key,
          });
        }
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: kd.key,
          code: kd.code,
          windowsVirtualKeyCode: kd.keyCode,
        });
        await new Promise((r) => setTimeout(r, 75));
      }
    } else {
      await send("Input.insertText", { text: opts.text });
    }

    if (opts.submit) {
      const enter = resolveKey("Enter");
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: enter.key,
        code: enter.code,
        windowsVirtualKeyCode: enter.keyCode,
      });
      await send("Input.dispatchKeyEvent", {
        type: "char",
        key: enter.key,
        text: "\r",
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: enter.key,
        code: enter.code,
        windowsVirtualKeyCode: enter.keyCode,
      });
    }
  });
}

export async function pressKeyViaCdp(opts: {
  wsUrl: string;
  key: string;
  delayMs?: number;
}): Promise<void> {
  await withCdpSocket(opts.wsUrl, async (send) => {
    const { modifiers, keyName } = parseKeyCombo(opts.key);

    // Press modifier keys.
    const modKeys: KeyDef[] = [];
    if (modifiers & 2) {
      modKeys.push({ key: "Control", code: "ControlLeft", keyCode: 17 });
    }
    if (modifiers & 4) {
      modKeys.push({ key: "Meta", code: "MetaLeft", keyCode: 91 });
    }
    if (modifiers & 1) {
      modKeys.push({ key: "Alt", code: "AltLeft", keyCode: 18 });
    }
    if (modifiers & 8) {
      modKeys.push({ key: "Shift", code: "ShiftLeft", keyCode: 16 });
    }

    for (const mk of modKeys) {
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: mk.key,
        code: mk.code,
        windowsVirtualKeyCode: mk.keyCode,
        modifiers,
      });
    }

    // Main key down.
    const kd = resolveKey(keyName);
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: kd.key,
      code: kd.code,
      windowsVirtualKeyCode: kd.keyCode,
      modifiers,
    });
    if (kd.key.length === 1) {
      await send("Input.dispatchKeyEvent", {
        type: "char",
        key: kd.key,
        text: kd.key,
        modifiers,
      });
    }

    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }

    // Main key up.
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: kd.key,
      code: kd.code,
      windowsVirtualKeyCode: kd.keyCode,
      modifiers,
    });

    // Release modifier keys (reverse order).
    for (let i = modKeys.length - 1; i >= 0; i--) {
      const mk = modKeys[i];
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mk.key,
        code: mk.code,
        windowsVirtualKeyCode: mk.keyCode,
        modifiers: 0,
      });
    }
  });
}

export async function hoverViaCdp(opts: {
  wsUrl: string;
  ref: string;
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  await withCdpSocket(opts.wsUrl, async (send) => {
    const elem = await resolveRefToElement(send, opts.ref, opts.cdpUrl, opts.targetId);
    await scrollIntoViewElement(send, elem.objectId);
    const rect = await getElementRect(send, elem.objectId);
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  });
}

export async function scrollIntoViewViaCdp(opts: {
  wsUrl: string;
  ref: string;
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  await withCdpSocket(opts.wsUrl, async (send) => {
    const elem = await resolveRefToElement(send, opts.ref, opts.cdpUrl, opts.targetId);
    await scrollIntoViewElement(send, elem.objectId);
  });
}
