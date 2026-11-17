/**
 * Fabric Chromium runs on servers without a GPU, so WebGL falls back to
 * SwiftShader and reports it as the unmasked renderer. Bot checks treat
 * "SwiftShader" (like "llvmpipe") as proof of automation and serve a block page
 * or a decoy. Every Fabric page therefore reports the integrated Intel GPU of an
 * ordinary Linux desktop, which matches the Linux Chrome User-Agent Fabric
 * presents. Only the two unmasked identification strings change; rendering and
 * every other WebGL parameter stay real.
 */
export const WEBGL_VENDOR = "Google Inc. (Intel)";
export const WEBGL_RENDERER = "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)";

/**
 * Main-world document-start script. getParameter is wrapped in a Proxy so the
 * function keeps its native name and length, and Function.prototype.toString
 * reports the original's `[native code]` source for it (a bare Proxy prints as
 * an anonymous function). No marker property is left for a page to find.
 * Applying it twice to one document only nests a second transparent Proxy.
 */
export const BROWSER_FINGERPRINT_SCRIPT = `(() => {
  const UNMASKED_VENDOR = 0x9245;
  const UNMASKED_RENDERER = 0x9246;
  const identity = { [UNMASKED_VENDOR]: ${JSON.stringify(WEBGL_VENDOR)}, [UNMASKED_RENDERER]: ${JSON.stringify(WEBGL_RENDERER)} };
  const originals = new WeakMap();
  const toString = Function.prototype.toString;
  try {
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: new Proxy(toString, {
        apply(target, self, args) {
          return Reflect.apply(target, originals.has(self) ? originals.get(self) : self, args);
        },
      }),
    });
    originals.set(Function.prototype.toString, toString);
  } catch (_) {
    // Without the toString bridge the identity still applies.
  }
  for (const context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    const prototype = context && context.prototype;
    if (!prototype) continue;
    try {
      const getParameter = prototype.getParameter;
      const wrapped = new Proxy(getParameter, {
        apply(target, self, args) {
          const name = args[0];
          if ((name === UNMASKED_VENDOR || name === UNMASKED_RENDERER) && self && self.getExtension('WEBGL_debug_renderer_info')) {
            return identity[name];
          }
          return Reflect.apply(target, self, args);
        },
      });
      originals.set(wrapped, getParameter);
      Object.defineProperty(prototype, 'getParameter', { configurable: true, enumerable: true, writable: true, value: wrapped });
    } catch (_) {
      // A hardened page may freeze the prototype. The session stays usable.
    }
  }
})()`;
