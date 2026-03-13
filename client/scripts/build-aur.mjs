import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.resolve(__dirname, "..");

function run(cmd, args, cwd = clientDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  const forwardedArgs = process.argv.slice(2);
  const wantsHelp = forwardedArgs.includes("--help") || forwardedArgs.includes("-h");

  if (wantsHelp) {
    await run(process.execPath, [path.join(__dirname, "stage-aur.mjs"), ...forwardedArgs], clientDir);
    return;
  }

  await run("npm", ["run", "build:linux"], clientDir);
  await run(process.execPath, [path.join(__dirname, "stage-aur.mjs"), ...forwardedArgs], clientDir);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
