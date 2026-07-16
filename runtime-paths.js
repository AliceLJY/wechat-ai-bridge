import { homedir } from "os";

function nonEmptyPath(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : "";
}

/**
 * Resolve the user's home directory without assuming the Unix-only HOME variable.
 * USERPROFILE covers Windows shells where HOME is unset; os.homedir() is the
 * platform fallback for both Bun and Node.
 */
export function resolveHomeDirectory(env = process.env, platformHome = homedir()) {
  return nonEmptyPath(env?.HOME)
    || nonEmptyPath(env?.USERPROFILE)
    || nonEmptyPath(platformHome)
    || process.cwd();
}
