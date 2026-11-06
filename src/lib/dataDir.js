import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      // Silently falling back is how the Docker data loss happens: the image
      // sets DATA_DIR=/app/data (the mounted volume), an --env-file overrides
      // it with a path the unprivileged `node` user cannot create, and the
      // database then lands in the home directory where no mount covers it.
      // The container is recreated on every update and the settings are gone.
      console.warn(
        `[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`,
      );
      console.warn(
        `[DATA_DIR] WARNING: the database will be written to ${defaultDir()}, ` +
          "which is probably NOT the path you mounted a volume on. In Docker, " +
          "pass -e DATA_DIR=/app/data (matching the -v mount) so the data " +
          "survives a container replacement.",
      );
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
