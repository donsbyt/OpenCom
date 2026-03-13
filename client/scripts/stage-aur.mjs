import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientDir,
  distDir,
  linuxReleaseManifestPath,
  loadClientPackageMetadata,
  loadLinuxPackagingConfig,
  writeLinuxReleaseManifest
} from "./release-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_RELEASE_BASE_URL = "https://opencom.online/downloads";
const DEFAULT_TARBALL_FILE_NAME = "OpenCom.tar.gz";
const REMOTE_HASH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

function bashQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function renderBashArray(values) {
  const items = (values || []).map((value) => `  ${bashQuote(value)}`);
  return `(\n${items.join("\n")}\n)`;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildArtifactSourceUrl(baseUrl, fileName) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return "";
  return `${normalizedBaseUrl}/${String(fileName || "").replace(/^\/+/, "")}`;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function sha256RemoteFile(urlString, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(urlString);
    } catch {
      reject(new Error(`Invalid source URL: ${urlString}`));
      return;
    }

    const transport = targetUrl.protocol === "https:"
      ? https
      : targetUrl.protocol === "http:"
        ? http
        : null;

    if (!transport) {
      reject(new Error(`Unsupported source URL protocol for hashing: ${targetUrl.protocol}`));
      return;
    }

    const request = transport.get(
      targetUrl,
      {
        headers: {
          "user-agent": "opencom-aur-stage/1.0"
        }
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectCount >= MAX_REDIRECTS) {
            response.resume();
            reject(new Error(`Too many redirects while hashing ${urlString}`));
            return;
          }

          response.resume();
          resolve(sha256RemoteFile(new URL(location, targetUrl).toString(), redirectCount + 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          let responseText = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (responseText.length < 512) {
              responseText += chunk;
            }
          });
          response.on("end", () => {
            const suffix = responseText.trim()
              ? ` Response: ${responseText.trim().slice(0, 200)}`
              : "";
            reject(new Error(`Failed to retrieve ${urlString}: HTTP ${statusCode}.${suffix}`));
          });
          response.on("error", reject);
          return;
        }

        const hash = crypto.createHash("sha256");
        response.on("data", (chunk) => hash.update(chunk));
        response.on("end", () => resolve(hash.digest("hex")));
        response.on("error", reject);
      },
    );

    request.setTimeout(REMOTE_HASH_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out retrieving ${urlString}`));
    });
    request.on("error", reject);
  });
}

function parseOptionValue(argv, index, flag) {
  const current = argv[index];
  if (current.includes("=")) {
    return {
      value: current.slice(current.indexOf("=") + 1),
      nextIndex: index,
    };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return {
    value,
    nextIndex: index + 1,
  };
}

function parseCliArgs(argv) {
  const options = {
    help: false,
    skipTarballSha256: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--skip-tarball-sha256") {
      options.skipTarballSha256 = true;
      continue;
    }

    if (
      arg === "--source-url" ||
      arg.startsWith("--source-url=") ||
      arg === "--release-base-url" ||
      arg.startsWith("--release-base-url=") ||
      arg === "--tarball-name" ||
      arg.startsWith("--tarball-name=") ||
      arg === "--tarball-sha256" ||
      arg.startsWith("--tarball-sha256=") ||
      arg === "--package-name" ||
      arg.startsWith("--package-name=") ||
      arg === "--pkgver" ||
      arg.startsWith("--pkgver=") ||
      arg === "--pkgrel" ||
      arg.startsWith("--pkgrel=") ||
      arg === "--output-dir" ||
      arg.startsWith("--output-dir=")
    ) {
      const { value, nextIndex } = parseOptionValue(argv, index, arg.split("=")[0]);
      index = nextIndex;

      switch (arg.split("=")[0]) {
        case "--source-url":
          options.sourceUrl = value;
          break;
        case "--release-base-url":
          options.releaseBaseUrl = value;
          break;
        case "--tarball-name":
          options.tarballFileName = value;
          break;
        case "--tarball-sha256":
          options.tarballSha256 = value;
          break;
        case "--package-name":
          options.packageName = value;
          break;
        case "--pkgver":
          options.pkgver = value;
          break;
        case "--pkgrel":
          options.pkgrel = value;
          break;
        case "--output-dir":
          options.outputDir = value;
          break;
        default:
          throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/stage-aur.mjs [options]

Generate the Arch/AUR package directory in client/dist/aur/.
Default tarball source: ${buildArtifactSourceUrl(DEFAULT_RELEASE_BASE_URL, DEFAULT_TARBALL_FILE_NAME)}

Options:
  --source-url <url>            Full tarball URL for PKGBUILD source=()
  --release-base-url <url>      Base URL used with --tarball-name
  --tarball-name <file>         Tarball alias used in PKGBUILD source=()
  --tarball-sha256 <sha256>     Override the tarball sha256 instead of hashing the URL
  --skip-tarball-sha256         Write SKIP for the tarball checksum
  --package-name <name>         Override the AUR package name/output folder
  --pkgver <version>            Override pkgver
  --pkgrel <release>            Override pkgrel
  --output-dir <path>           Override output directory (default: dist/aur/<package>)
  -h, --help                    Show this help text

Environment overrides:
  OPENCOM_AUR_SOURCE_URL
  OPENCOM_AUR_RELEASE_BASE_URL
  OPENCOM_AUR_TARBALL_NAME
  OPENCOM_AUR_TARBALL_SHA256
  OPENCOM_AUR_SKIP_TARBALL_SHA256=1
  OPENCOM_AUR_PACKAGE_NAME
  OPENCOM_AUR_PKGVER
  OPENCOM_AUR_PKGREL
  OPENCOM_AUR_OUTPUT_DIR
`);
}

function loadEnvOverrides() {
  return {
    sourceUrl: process.env.OPENCOM_AUR_SOURCE_URL,
    releaseBaseUrl: process.env.OPENCOM_AUR_RELEASE_BASE_URL,
    tarballFileName: process.env.OPENCOM_AUR_TARBALL_NAME,
    tarballSha256: process.env.OPENCOM_AUR_TARBALL_SHA256,
    skipTarballSha256: process.env.OPENCOM_AUR_SKIP_TARBALL_SHA256 === "1",
    packageName: process.env.OPENCOM_AUR_PACKAGE_NAME,
    pkgver: process.env.OPENCOM_AUR_PKGVER,
    pkgrel: process.env.OPENCOM_AUR_PKGREL,
    outputDir: process.env.OPENCOM_AUR_OUTPUT_DIR,
  };
}

function mergeOptions(cliOptions, envOptions) {
  return {
    sourceUrl: cliOptions.sourceUrl || envOptions.sourceUrl,
    releaseBaseUrl: cliOptions.releaseBaseUrl || envOptions.releaseBaseUrl,
    tarballFileName: cliOptions.tarballFileName || envOptions.tarballFileName,
    tarballSha256: cliOptions.tarballSha256 || envOptions.tarballSha256,
    skipTarballSha256: cliOptions.skipTarballSha256 || envOptions.skipTarballSha256,
    packageName: cliOptions.packageName || envOptions.packageName,
    pkgver: cliOptions.pkgver || envOptions.pkgver,
    pkgrel: cliOptions.pkgrel || envOptions.pkgrel,
    outputDir: cliOptions.outputDir || envOptions.outputDir,
  };
}

function renderDesktopFile({ packaging, pkg }) {
  const categories = Array.isArray(packaging.categories)
    ? `${packaging.categories.join(";")};`
    : "Network;";

  return `[Desktop Entry]
Name=${packaging.desktopName || "OpenCom"}
Comment=${pkg.description || "Desktop wrapper for OpenCom"}
Exec=${packaging.commandName || "opencom"} %U
Terminal=false
Type=Application
Icon=${path.parse(packaging.iconFileName || "opencom.png").name}
Categories=${categories}
StartupWMClass=${packaging.desktopStartupWMClass || packaging.desktopName || "OpenCom"}
`;
}

function renderPkgbuild({ packaging, pkg, aur }) {
  const iconFileName = packaging.iconFileName || "opencom.png";
  const desktopFileName = packaging.desktopFileName || "opencom.desktop";
  const extractDir = "OpenCom";

  const sourceEntries = [
    `${aur.tarballFileName}::${aur.sourceUrl}`,
    desktopFileName,
    iconFileName
  ];
  const shaEntries = [
    aur.tarballSha256,
    "SKIP",
    "SKIP"
  ];

  const lines = [
    "# Maintainer: OpenCom Release Automation <don@opencom.online>",
    "# Generated by client/scripts/stage-aur.mjs",
    `pkgname=${aur.packageName}`,
    `pkgver=${aur.pkgver}`,
    `pkgrel=${aur.pkgrel}`,
    `pkgdesc=${bashQuote(pkg.description || "Desktop wrapper for OpenCom")}`,
    `arch=${renderBashArray(packaging.architectures || ["x86_64"])}`,
    `url=${bashQuote(pkg.homepage || "https://opencom.online")}`,
    `license=${renderBashArray(packaging.licenses || ["GPL3"])}`,
    `depends=${renderBashArray(packaging.runtimeDependencies || [])}`,
  ];

  if (Array.isArray(packaging.optionalDependencies) && packaging.optionalDependencies.length) {
    lines.push(
      `optdepends=${renderBashArray(
        packaging.optionalDependencies.map(
          (item) => `${item.name}: ${item.description}`,
        ),
      )}`,
    );
  }

  if (Array.isArray(packaging.provides) && packaging.provides.length) {
    lines.push(`provides=${renderBashArray(packaging.provides)}`);
  }
  if (Array.isArray(packaging.conflicts) && packaging.conflicts.length) {
    lines.push(`conflicts=${renderBashArray(packaging.conflicts)}`);
  }

  lines.push(`source=${renderBashArray(sourceEntries)}`);
  lines.push(`sha256sums=${renderBashArray(shaEntries)}`);
  lines.push("");
  lines.push("package() {");
  lines.push(
    `  install -dm755 "$pkgdir/opt/${packaging.installDirName || "opencom"}"`,
  );
  lines.push(
    `  cp -a "$srcdir/${extractDir}/." "$pkgdir/opt/${packaging.installDirName || "opencom"}/"`,
  );
  lines.push('  install -dm755 "$pkgdir/usr/bin"');
  lines.push(
    `  ln -sf "/opt/${packaging.installDirName || "opencom"}/${packaging.binaryName || "opencom-client"}" "$pkgdir/usr/bin/${packaging.commandName || "opencom"}"`,
  );
  lines.push(
    `  install -Dm644 "$srcdir/${desktopFileName}" "$pkgdir/usr/share/applications/${desktopFileName}"`,
  );
  lines.push(
    `  install -Dm644 "$srcdir/${iconFileName}" "$pkgdir/usr/share/pixmaps/${iconFileName}"`,
  );
  lines.push("}");

  return `${lines.join("\n")}\n`;
}

function renderSrcInfo({ packaging, pkg, aur }) {
  const iconFileName = packaging.iconFileName || "opencom.png";
  const desktopFileName = packaging.desktopFileName || "opencom.desktop";
  const lines = [
    `pkgbase = ${aur.packageName}`,
    `\tpkgdesc = ${pkg.description || "Desktop wrapper for OpenCom"}`,
    `\tpkgver = ${aur.pkgver}`,
    `\tpkgrel = ${aur.pkgrel}`,
    `\turl = ${pkg.homepage || "https://opencom.online"}`,
  ];

  for (const item of packaging.architectures || ["x86_64"]) lines.push(`\tarch = ${item}`);
  for (const item of packaging.licenses || ["GPL3"]) lines.push(`\tlicense = ${item}`);
  for (const item of packaging.runtimeDependencies || []) lines.push(`\tdepends = ${item}`);
  for (const item of packaging.optionalDependencies || []) {
    lines.push(`\toptdepends = ${item.name}: ${item.description}`);
  }
  for (const item of packaging.provides || []) lines.push(`\tprovides = ${item}`);
  for (const item of packaging.conflicts || []) lines.push(`\tconflicts = ${item}`);
  lines.push(`\tsource = ${aur.tarballFileName}::${aur.sourceUrl}`);
  lines.push(`\tsource = ${desktopFileName}`);
  lines.push(`\tsource = ${iconFileName}`);
  lines.push(`\tsha256sums = ${aur.tarballSha256}`);
  lines.push("\tsha256sums = SKIP");
  lines.push("\tsha256sums = SKIP");
  lines.push("");
  lines.push(`pkgname = ${aur.packageName}`);
  return `${lines.join("\n")}\n`;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function tryRenderSrcInfoWithMakepkg(outputDir) {
  const result = spawnSync("makepkg", ["--printsrcinfo"], {
    cwd: outputDir,
    encoding: "utf8"
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "");
}

async function loadManifestIfAvailable() {
  if (await fileExists(linuxReleaseManifestPath)) {
    const raw = await fs.readFile(linuxReleaseManifestPath, "utf8");
    return JSON.parse(raw);
  }

  try {
    return await writeLinuxReleaseManifest();
  } catch {
    return null;
  }
}

function resolveAurConfig({ packaging, pkg, manifest, options }) {
  const packageName = options.packageName || manifest?.aur?.packageName || packaging.aurPackageName || "opencom-bin";
  const pkgver = options.pkgver || pkg.version;
  const pkgrel = String(options.pkgrel || manifest?.aur?.pkgrel || packaging.aurPackageRelease || 1);
  const tarballFileName = options.tarballFileName || packaging.releaseFileName || manifest?.aur?.tarballFileName || DEFAULT_TARBALL_FILE_NAME;
  const sourceUrl =
    options.sourceUrl ||
    buildArtifactSourceUrl(options.releaseBaseUrl, tarballFileName) ||
    buildArtifactSourceUrl(packaging.releaseBaseUrl || DEFAULT_RELEASE_BASE_URL, tarballFileName) ||
    manifest?.aur?.sourceUrl ||
    buildArtifactSourceUrl(`${pkg.homepage || ""}/downloads`, tarballFileName);

  if (!sourceUrl) {
    throw new Error(
      "AUR source URL is empty. Pass --source-url or --release-base-url, or set releaseBaseUrl in client/packaging/linux.json.",
    );
  }

  const outputDir = options.outputDir
    ? path.resolve(clientDir, options.outputDir)
    : path.join(distDir, "aur", packageName);

  return {
    packageName,
    pkgver,
    pkgrel,
    sourceUrl,
    tarballFileName,
    outputDir,
  };
}

async function resolveTarballSha256({ options, aur, manifest }) {
  if (options.skipTarballSha256) return "SKIP";
  if (options.tarballSha256) return options.tarballSha256;

  if (isHttpUrl(aur.sourceUrl)) {
    return sha256RemoteFile(aur.sourceUrl);
  }

  if (manifest?.aur?.tarballSha256) {
    return manifest.aur.tarballSha256;
  }

  throw new Error(
    "Tarball sha256 is unavailable. Pass --tarball-sha256, use --skip-tarball-sha256, or use an http(s) source URL that can be hashed.",
  );
}

async function stageAur({ options }) {
  const [packaging, pkg, manifest] = await Promise.all([
    loadLinuxPackagingConfig(),
    loadClientPackageMetadata(),
    loadManifestIfAvailable(),
  ]);

  const aur = resolveAurConfig({ packaging, pkg, manifest, options });
  aur.tarballSha256 = await resolveTarballSha256({ options, aur, manifest });
  await fs.mkdir(aur.outputDir, { recursive: true });

  const desktopFilePath = path.join(
    aur.outputDir,
    packaging.desktopFileName || "opencom.desktop",
  );
  const iconTargetPath = path.join(
    aur.outputDir,
    packaging.iconFileName || "opencom.png",
  );
  const pkgbuildPath = path.join(aur.outputDir, "PKGBUILD");
  const srcInfoPath = path.join(aur.outputDir, ".SRCINFO");
  const iconSourcePath = path.resolve(clientDir, packaging.iconSource || "src/web/logo.png");

  await fs.writeFile(
    desktopFilePath,
    renderDesktopFile({ packaging, pkg }),
    "utf8",
  );
  await fs.copyFile(iconSourcePath, iconTargetPath);
  await fs.writeFile(
    pkgbuildPath,
    renderPkgbuild({ packaging, pkg, aur }),
    "utf8",
  );

  const renderedSrcInfo =
    tryRenderSrcInfoWithMakepkg(aur.outputDir) ||
    renderSrcInfo({ packaging, pkg, aur });

  await fs.writeFile(
    srcInfoPath,
    renderedSrcInfo,
    "utf8",
  );

  console.log(`Generated AUR skeleton in ${path.relative(clientDir, aur.outputDir)}`);
  console.log(`Tarball source: ${aur.sourceUrl}`);
  console.log(`Tarball sha256: ${aur.tarballSha256}`);
}

async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.help) {
    printHelp();
    return;
  }

  const envOptions = loadEnvOverrides();
  const options = mergeOptions(cliOptions, envOptions);
  await stageAur({ options });
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
