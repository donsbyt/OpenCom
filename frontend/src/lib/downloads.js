function normalizeBasePath(basePath = "/") {
  const value = String(basePath || "/").trim();
  if (!value) return "/";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const DOWNLOAD_BASE_PATH = `${normalizeBasePath(import.meta.env.BASE_URL)}/downloads`;

const DOWNLOAD_TARGET_ORDER = [
  "android",
  "windows",
  "linux_deb",
  "linux_rpm",
  "linux_snap",
  "linux_tar",
];

const DOWNLOAD_BUILD_META = {
  android: {
    label: "Android (.apk)",
    platform: "android",
    family: "mobile",
  },
  windows: {
    label: "Windows (.exe)",
    platform: "windows",
    family: "desktop",
  },
  linux_deb: {
    label: "Linux (.deb)",
    platform: "linux",
    family: "desktop",
  },
  linux_rpm: {
    label: "Linux (.rpm)",
    platform: "linux",
    family: "desktop",
  },
  linux_snap: {
    label: "Linux (.snap)",
    platform: "linux",
    family: "desktop",
  },
  linux_tar: {
    label: "Linux (.tar.gz)",
    platform: "linux",
    family: "desktop",
  },
};

export const DOWNLOAD_TARGETS = [
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.apk`,
    label: "Android (.apk)",
    platform: "android",
    family: "mobile",
    type: "android",
  },
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.exe`,
    label: "Windows (.exe)",
    platform: "windows",
    family: "desktop",
    type: "windows",
  },
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.deb`,
    label: "Linux (.deb)",
    platform: "linux",
    family: "desktop",
    type: "linux_deb",
  },
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.rpm`,
    label: "Linux (.rpm)",
    platform: "linux",
    family: "desktop",
    type: "linux_rpm",
  },
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.snap`,
    label: "Linux (.snap)",
    platform: "linux",
    family: "desktop",
    type: "linux_snap",
  },
  {
    href: `${DOWNLOAD_BASE_PATH}/OpenCom.tar.gz`,
    label: "Linux (.tar.gz)",
    platform: "linux",
    family: "desktop",
    type: "linux_tar",
  }
];

export function buildDownloadTargetsFromBuilds(builds = []) {
  const normalizedTargets = Array.isArray(builds)
    ? builds
        .map((build) => {
          const type = String(build?.type || "").trim();
          const meta = DOWNLOAD_BUILD_META[type];
          const href = String(build?.downloadUrl || "").trim();
          if (!meta || !href) return null;
          return {
            ...meta,
            type,
            href,
            version: String(build?.version || "").trim() || null,
            fileName: String(build?.fileName || "").trim() || null,
            fileSize: Number.isFinite(Number(build?.fileSize))
              ? Number(build.fileSize)
              : null,
            checksum: String(build?.checksum || "").trim() || null,
            publishedAt: String(build?.publishedAt || "").trim() || null,
          };
        })
        .filter(Boolean)
    : [];

  return normalizedTargets.sort(
    (left, right) =>
      DOWNLOAD_TARGET_ORDER.indexOf(left.type) -
      DOWNLOAD_TARGET_ORDER.indexOf(right.type),
  );
}

export async function fetchDownloadTargets(coreApi, options = {}) {
  const channel = String(options.channel || "stable").trim() || "stable";
  const fetchImpl =
    options.fetchImpl ||
    (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!fetchImpl || !coreApi) {
    return DOWNLOAD_TARGETS;
  }

  try {
    const response = await fetchImpl(
      `${String(coreApi).replace(/\/$/, "")}/v1/client/builds?channel=${encodeURIComponent(channel)}`,
      {
        signal: options.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    const targets = buildDownloadTargetsFromBuilds(payload?.builds || []);
    return targets.length ? targets : DOWNLOAD_TARGETS;
  } catch {
    return DOWNLOAD_TARGETS;
  }
}

export function getDeviceDownloadContext() {
  if (typeof navigator === "undefined") {
    return { isMobile: false, isAndroid: false, isIOS: false };
  }

  const platform = `${navigator.platform || ""}`.toLowerCase();
  const userAgent = `${navigator.userAgent || ""}`.toLowerCase();
  const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
  const isAndroid = userAgent.includes("android");
  const isIOS =
    /iphone|ipad|ipod/.test(userAgent) ||
    (platform.includes("mac") && maxTouchPoints > 1);
  const isMobile =
    isAndroid ||
    isIOS ||
    userAgent.includes("mobile") ||
    userAgent.includes("tablet");

  return { isMobile, isAndroid, isIOS };
}

export function getMobileDownloadTarget(targets = DOWNLOAD_TARGETS) {
  return targets.find((target) => target.platform === "android") || null;
}

export function getPreferredDownloadTarget(targets = DOWNLOAD_TARGETS) {
  if (typeof navigator === "undefined") return targets[0] || null;
  const platform = `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  const { isAndroid } = getDeviceDownloadContext();
  if (isAndroid) {
    return getMobileDownloadTarget(targets) || targets[0] || null;
  }
  if (platform.includes("win")) {
    return targets.find((target) => target.platform === "windows") || targets[0] || null;
  }
  return (
    targets.find((target) => target.platform === "linux" && target.label.toLowerCase().includes(".deb")) ||
    targets.find((target) => target.platform === "linux" && target.label.toLowerCase().includes(".rpm")) ||
    targets.find((target) => target.platform === "linux") ||
    targets[0] ||
    null
  );
}
