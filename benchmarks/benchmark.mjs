/**
 * GCF vs TOON vs JSON benchmark + TOON corruption proof on subtitle data.
 * GCF = Graph Compact Format (https://gcformat.com)
 *
 * Usage: node benchmarks/benchmark.mjs
 */

import { encode as toonEncode, decode as toonDecode } from '@toon-format/toon';
import { encodeGeneric, decodeGeneric } from '@blackwell-systems/gcf';

function tokenEstimate(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

// --- Generate realistic subtitle entries matching toMsEntry format ---

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function msToTimestamp(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(f)}`;
}

const SAMPLE_TEXTS = [
  "Welcome to today's presentation.",
  "Let me show you the dashboard.",
  "Click on the settings icon [gear].",
  "Navigate to https://example.com/api/v2.",
  "Enter your API key: sk-abc123-xyz.",
  "The error code is ERR[404]: Not Found.",
  "Check the logs at /var/log/app.log.",
  "Use the format {name: value} for config.",
  "Temperature is set to 72°F.",
  "The meeting starts at 10:30 AM.",
  "Press Ctrl+C to stop the process.",
  "See section [3.2] for details.",
  "The output looks like: {status: ok}.",
  "Path: C:\\Users\\admin\\Documents",
  "Version 2.1.0-beta.3 is available.",
  "Run: docker compose up -d",
  "The ratio is 16:9 for widescreen.",
  "Price: $19.99 (excl. tax)",
  "Email: support@company.com",
  "Timestamp: 2026-06-18T10:30:00Z",
];

function generateSubtitles(n) {
  const entries = [];
  let ms = 0;
  for (let i = 0; i < n; i++) {
    const duration = 2000 + Math.floor(Math.random() * 4000);
    const gap = 100 + Math.floor(Math.random() * 500);
    entries.push({
      index: i + 1,
      start: msToTimestamp(ms),
      end: msToTimestamp(ms + duration),
      text: SAMPLE_TEXTS[i % SAMPLE_TEXTS.length],
    });
    ms += duration + gap;
  }
  return { inputs: entries };
}

// =====================================================================
// PART 1: TOKEN BENCHMARK
// =====================================================================

console.log('='.repeat(80));
console.log('PART 1: Token Benchmark — GCF vs TOON vs JSON on Subtitle Data');
console.log('='.repeat(80));
console.log();

const SIZES = [10, 50, 100, 200, 500];

console.log(
  `${'Rows'.padStart(6)}  ${'JSON'.padStart(8)}  ${'TOON'.padStart(8)}  ${'GCF'.padStart(8)}  ${'TOON%'.padStart(7)}  ${'GCF%'.padStart(7)}  ${'GCF vs TOON'.padStart(12)}`
);
console.log('-'.repeat(80));

const results = [];

for (const size of SIZES) {
  const data = generateSubtitles(size);
  const jsonStr = JSON.stringify(data);
  const toonStr = toonEncode(data);
  const gcfStr = encodeGeneric(data);

  const jsonTok = tokenEstimate(jsonStr);
  const toonTok = tokenEstimate(toonStr);
  const gcfTok = tokenEstimate(gcfStr);

  const toonPct = ((1 - toonTok / jsonTok) * 100).toFixed(1);
  const gcfPct = ((1 - gcfTok / jsonTok) * 100).toFixed(1);
  const gcfVsToon = ((1 - gcfTok / toonTok) * 100).toFixed(1);

  results.push({ size, jsonTok, toonTok, gcfTok });

  console.log(
    `${String(size).padStart(6)}  ${String(jsonTok.toLocaleString()).padStart(8)}  ${String(toonTok.toLocaleString()).padStart(8)}  ${String(gcfTok.toLocaleString()).padStart(8)}  ${(toonPct + '%').padStart(7)}  ${(gcfPct + '%').padStart(7)}  ${((gcfVsToon > 0 ? '+' : '') + gcfVsToon + '%').padStart(12)}`
  );
}

const totalJson = results.reduce((s, r) => s + r.jsonTok, 0);
const totalToon = results.reduce((s, r) => s + r.toonTok, 0);
const totalGcf = results.reduce((s, r) => s + r.gcfTok, 0);

console.log();
console.log(`Total JSON: ${totalJson.toLocaleString()} | TOON: ${totalToon.toLocaleString()} (${((1 - totalToon / totalJson) * 100).toFixed(1)}%) | GCF: ${totalGcf.toLocaleString()} (${((1 - totalGcf / totalJson) * 100).toFixed(1)}%) | GCF vs TOON: ${((1 - totalGcf / totalToon) * 100).toFixed(1)}%`);

// =====================================================================
// PART 2: TOON CORRUPTION PROOF
// =====================================================================

console.log();
console.log('='.repeat(80));
console.log('PART 2: TOON Corruption Proof — Round-Trip Data Integrity');
console.log('='.repeat(80));
console.log();

const testData = generateSubtitles(50);
const entries = testData.inputs;

let toonCorruptions = 0;
let toonErrors = 0;
let gcfCorruptions = 0;
let gcfErrors = 0;

// Test each entry individually
for (const entry of entries) {
  // TOON round-trip
  try {
    const encoded = toonEncode(entry);
    const decoded = toonDecode(encoded);
    if (JSON.stringify(decoded) !== JSON.stringify(entry)) {
      toonCorruptions++;
      if (toonCorruptions <= 5) {
        console.log(`TOON CORRUPTION on entry ${entry.index}:`);
        console.log(`  Original: ${JSON.stringify(entry)}`);
        console.log(`  Decoded:  ${JSON.stringify(decoded)}`);
        console.log(`  Encoded:  ${encoded}`);
        console.log();
      }
    }
  } catch (e) {
    toonErrors++;
    if (toonErrors <= 3) {
      console.log(`TOON ERROR on entry ${entry.index}: ${e.message}`);
    }
  }

  // GCF round-trip
  try {
    const encoded = encodeGeneric(entry);
    const decoded = decodeGeneric(encoded);
    if (JSON.stringify(decoded) !== JSON.stringify(entry)) {
      gcfCorruptions++;
    }
  } catch (e) {
    gcfErrors++;
  }
}

// Also test strings that contain TOON structural characters
const dangerousStrings = [
  '00:01:23,456',          // timestamp with colons
  'ERR[404]: Not Found',   // brackets + colon
  '{status: ok}',          // braces + colon
  'key: value, other: 2',  // colons + comma
  'path/to/[file].txt',    // brackets
  'http://example.com:8080/api', // URL with colon and port
  'config={debug:true}',   // braces + colon + equals
  '[Speaker 1]: Hello',    // bracket + colon
];

let dangerToonFails = 0;
let dangerGcfFails = 0;

console.log('--- Dangerous String Round-Trip Test ---');
console.log();

for (const s of dangerousStrings) {
  const obj = { text: s };

  try {
    const decoded = toonDecode(toonEncode(obj));
    if (decoded.text !== s) {
      dangerToonFails++;
      console.log(`TOON FAIL: "${s}" → "${decoded.text}"`);
    }
  } catch {
    dangerToonFails++;
    console.log(`TOON ERROR: "${s}"`);
  }

  try {
    const decoded = decodeGeneric(encodeGeneric(obj));
    if (decoded.text !== s) {
      dangerGcfFails++;
    }
  } catch {
    dangerGcfFails++;
  }
}

console.log();
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log();
console.log(`Subtitle entries tested: ${entries.length}`);
console.log(`TOON corruptions: ${toonCorruptions} | TOON errors: ${toonErrors}`);
console.log(`GCF corruptions:  ${gcfCorruptions} | GCF errors:  ${gcfErrors}`);
console.log();
console.log(`Dangerous strings tested: ${dangerousStrings.length}`);
console.log(`TOON failures: ${dangerToonFails}/${dangerousStrings.length}`);
console.log(`GCF failures:  ${dangerGcfFails}/${dangerousStrings.length}`);
