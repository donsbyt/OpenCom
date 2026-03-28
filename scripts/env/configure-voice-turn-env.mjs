#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const ENV_PATH = path.join(ROOT, "backend/.env");
const EXAMPLE_PATH = path.join(ROOT, "backend/.env.example");

function parseEnv(content) {
  const entries = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries.set(match[1], match[2]);
  }
  return entries;
}

function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) {
    return fs.readFileSync(ENV_PATH, "utf8");
  }
  if (!fs.existsSync(EXAMPLE_PATH)) {
    throw new Error("backend/.env.example is missing");
  }
  const content = fs.readFileSync(EXAMPLE_PATH, "utf8");
  fs.writeFileSync(ENV_PATH, content, "utf8");
  return content;
}

function upsertEnvValue(content, key, value) {
  const normalizedValue = String(value ?? "");
  const line = `${key}=${normalizedValue}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const trimmed = content.replace(/\s*$/, "");
  return `${trimmed}\n${line}\n`;
}

function normalizeList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

function normalizePositiveInt(rawValue, fallback) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return String(fallback);
  return String(value);
}

function generateSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function isYes(value) {
  return ["y", "yes"].includes(String(value || "").trim().toLowerCase());
}

async function askWithDefault(rl, label, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed || fallback;
}

async function main() {
  let envContent = ensureEnvFile();
  const current = parseEnv(envContent);
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`Updating ${path.relative(ROOT, ENV_PATH)} only.`);

    const stunUrls = normalizeList(
      await askWithDefault(
        rl,
        "STUN URLs (comma-separated)",
        current.get("VOICE_STUN_URLS") || "stun:stun.l.google.com:19302",
      ),
    );

    const configureTurnAnswer = await askWithDefault(
      rl,
      "Configure TURN now? (y/N)",
      current.get("VOICE_TURN_URLS") ? "y" : "n",
    );

    let turnUrls = current.get("VOICE_TURN_URLS") || "";
    let turnSecret = current.get("VOICE_TURN_SECRET") || "";
    let turnTtl = normalizePositiveInt(
      current.get("VOICE_TURN_TTL_SECONDS") || "3600",
      3600,
    );

    if (isYes(configureTurnAnswer)) {
      turnUrls = normalizeList(
        await askWithDefault(
          rl,
          "TURN URLs (comma-separated)",
          turnUrls,
        ),
      );

      const generatedSecret = generateSecret();
      turnSecret = await askWithDefault(
        rl,
        "TURN shared secret",
        turnSecret || generatedSecret,
      );

      turnTtl = normalizePositiveInt(
        await askWithDefault(
          rl,
          "TURN credential TTL seconds",
          turnTtl,
        ),
        3600,
      );
    } else {
      turnUrls = "";
      turnSecret = "";
      turnTtl = "3600";
    }

    envContent = upsertEnvValue(envContent, "VOICE_STUN_URLS", stunUrls);
    envContent = upsertEnvValue(envContent, "VOICE_TURN_URLS", turnUrls);
    envContent = upsertEnvValue(envContent, "VOICE_TURN_SECRET", turnSecret);
    envContent = upsertEnvValue(envContent, "VOICE_TURN_TTL_SECONDS", turnTtl);

    fs.writeFileSync(ENV_PATH, envContent, "utf8");

    console.log("");
    console.log("Saved voice ICE settings to backend/.env");
    console.log(`VOICE_STUN_URLS=${stunUrls}`);
    console.log(`VOICE_TURN_URLS=${turnUrls || "<empty>"}`);
    console.log(`VOICE_TURN_SECRET=${turnSecret ? "<set>" : "<empty>"}`);
    console.log(`VOICE_TURN_TTL_SECONDS=${turnTtl}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
