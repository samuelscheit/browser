/**
 * The browser executable inside Fabric's browser image: a link to Google Chrome stable on amd64 and
 * to Debian's Chromium on arm64 (workers/chrome/Dockerfile). A federated local worker maps it to
 * its configured host browser.
 */
export const FABRIC_BROWSER_EXECUTABLE = "/usr/local/bin/fabric-browser";

