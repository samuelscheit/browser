/**
 * Docker creates every tmpfs mount as root:root. Unless the mount is world-writable (Docker's
 * default 1777), a non-root service user cannot create anything in it, and tools that need a
 * temp directory fail only at runtime (Playwright's driver mkdtemp()s under /tmp on every
 * connect_over_cdp). Any service with a restricted tmpfs must therefore declare its numeric user
 * explicitly, and a non-root user must own each restricted tmpfs through `uid=`/`gid=` options.
 */

type ComposeService = {
  user?: unknown;
  tmpfs?: unknown;
  volumes?: unknown;
};

type TmpfsMount = { target: string; options: Map<string, string> };

const DOCKER_DEFAULT_TMPFS_MODE = 0o1777;

function shortSyntaxMounts(tmpfs: unknown): TmpfsMount[] {
  const entries = tmpfs === undefined ? [] : Array.isArray(tmpfs) ? tmpfs : [tmpfs];
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new Error("tmpfs entries must use the short string syntax");
    const separator = entry.indexOf(":");
    const target = separator < 0 ? entry : entry.slice(0, separator);
    const options = new Map<string, string>();
    for (const option of separator < 0 ? [] : entry.slice(separator + 1).split(",")) {
      const [key = "", value = ""] = option.split("=", 2);
      options.set(key, value);
    }
    return { target, options };
  });
}

function hasLongSyntaxTmpfs(volumes: unknown): boolean {
  return Array.isArray(volumes) && volumes.some((volume) => typeof volume === "object" && volume !== null && (volume as { type?: unknown }).type === "tmpfs");
}

function isWorldWritable(mount: TmpfsMount): boolean {
  const raw = mount.options.get("mode");
  const mode = raw === undefined ? DOCKER_DEFAULT_TMPFS_MODE : Number.parseInt(raw, 8);
  return Number.isInteger(mode) && (mode & 0o002) !== 0;
}

function numericUser(user: unknown): { uid: string; gid: string } | undefined {
  if (typeof user !== "string" && typeof user !== "number") return undefined;
  const match = String(user).match(/^(\d+)(?::(\d+))?$/);
  return match ? { uid: match[1]!, gid: match[2] ?? match[1]! } : undefined;
}

/** Return one human-readable violation per restricted tmpfs the service user cannot write. */
export function tmpfsOwnershipViolations(composeText: string): string[] {
  const document = Bun.YAML.parse(composeText) as { services?: Record<string, ComposeService> };
  const violations: string[] = [];
  for (const [name, service] of Object.entries(document.services ?? {})) {
    if (hasLongSyntaxTmpfs(service.volumes)) {
      violations.push(`${name} must declare tmpfs mounts with the short syntax so uid/gid ownership is explicit`);
    }
    const restricted = shortSyntaxMounts(service.tmpfs).filter((mount) => !isWorldWritable(mount));
    if (restricted.length === 0) continue;
    const user = numericUser(service.user);
    if (!user) {
      // An implicit image USER or a named user cannot be checked against uid=/gid= options.
      violations.push(`${name} has a restricted tmpfs and must declare an explicit numeric user`);
      continue;
    }
    if (user.uid === "0") continue;
    for (const mount of restricted) {
      if (mount.options.get("uid") !== user.uid || mount.options.get("gid") !== user.gid) {
        violations.push(`${name} tmpfs ${mount.target} must be owned by its service user ${user.uid}:${user.gid}`);
      }
    }
  }
  return violations;
}
