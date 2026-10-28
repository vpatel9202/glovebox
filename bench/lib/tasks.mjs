// The seven benchmark tasks. Each one resets its own state in setup(), gives
// every setup the same prompt, and checks the result with verify() through
// files, defaults, or an oracle read, never through the tool under test.
//
// `app` is the window the screenshot-first setup sees. `kind` is "text" when
// the accessibility tree is enough and "pixel" when the task needs pixels.
// `followUps` are later user turns in the same conversation (the replay task).
import fs from "node:fs";
import path from "node:path";
import {
  closeBenchTextEdit,
  closeFinderWindow,
  launchFixture,
  oracleKeys,
  oracleRead,
  osascript,
  quitApp,
  quitFixture,
  readJsonLines,
  sh,
  sleep,
  waitFor,
  workDir,
} from "./env.mjs";

const notesPath = path.join(workDir, "notes.txt");
const scratchPath = path.join(workDir, "scratch.txt");
// Finder caches a folder's listing by path, and deleting and recreating the
// folder doesn't clear it, so each run gets a "finder-task" folder at a path
// Finder has never shown.
const finderRoot = path.join(workDir, "finder");
let finderDir = path.join(finderRoot, "unused", "finder-task");
const formOut = path.join(workDir, "form.jsonl");
const canvasOut = path.join(workDir, "canvas.jsonl");

const NOTES = "Meeting notes\nAttendees: Alice, Carol\nAction: send the report on Friday\n";
const NOTES_EXPECTED = "Meeting notes\nAttendees: Alice, Carol\nAction: send the report on Thursday\nOwner: Bob";

const PEOPLE = [
  { name: "Ada Lovelace", email: "ada@example.com", department: "Engineering", newsletter: true },
  { name: "Grace Hopper", email: "grace@example.com", department: "Support", newsletter: false },
  { name: "Alan Turing", email: "alan@example.com", department: "Sales", newsletter: true },
];

function describePerson(p) {
  return `name "${p.name}", email ${p.email}, department ${p.department}, ${p.newsletter ? "subscribed" : "not subscribed"} to the newsletter`;
}

function sameRecords(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every(
      (e, i) => actual[i].name === e.name && actual[i].email === e.email && actual[i].department === e.department && actual[i].newsletter === e.newsletter,
    )
  );
}

async function openTextEdit(file) {
  await sh("open", ["-a", "TextEdit", file]);
  await waitFor(async () => (await sh("osascript", ["-e", 'tell application "TextEdit" to count documents']).catch(() => "0")) !== "0");
  await sleep(800);
}

export const TASKS = [
  {
    id: "calculator",
    app: "Calculator",
    kind: "text",
    prompt: "In Calculator, compute 1234 × 56 − 789 and leave the result on the display.",
    async setup() {
      await quitApp("Calculator");
      await sh("open", ["-a", "Calculator"]);
      await sleep(1500);
      // Calculator restores its last display on relaunch; clear it.
      await oracleKeys("Calculator", "Escape Escape");
    },
    async verify() {
      const tree = await oracleRead("Calculator");
      const ok = /68,?315\b/.test(tree) && !/68,?315\d/.test(tree);
      return { ok, detail: ok ? "display shows 68315" : "68315 not on the display" };
    },
    async teardown() {
      await quitApp("Calculator");
    },
  },
  {
    id: "textedit-edit",
    app: "TextEdit",
    kind: "text",
    prompt:
      'In TextEdit, the document notes.txt is open. Change "Friday" to "Thursday", add a new last line that says "Owner: Bob", and save the document.',
    async setup() {
      await closeBenchTextEdit();
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(notesPath, NOTES);
      await openTextEdit(notesPath);
    },
    async verify() {
      const text = fs.readFileSync(notesPath, "utf8").replace(/\s+$/, "");
      const ok = text === NOTES_EXPECTED;
      return { ok, detail: ok ? "file saved with both edits" : `file is ${JSON.stringify(text)}` };
    },
    teardown: closeBenchTextEdit,
  },
  {
    id: "finder-rename",
    app: "Finder",
    kind: "text",
    prompt: 'In Finder, the folder "finder-task" is open. Rename the file draft-v1.txt to final-report.txt.',
    async setup() {
      await closeFinderWindow("finder-task");
      fs.rmSync(finderRoot, { recursive: true, force: true });
      finderDir = path.join(finderRoot, String(Date.now()), "finder-task");
      fs.mkdirSync(finderDir, { recursive: true });
      for (const name of ["draft-v1.txt", "budget.txt", "photo-list.txt"]) fs.writeFileSync(path.join(finderDir, name), `${name}\n`);
      await sh("open", [finderDir]);
      // The task must start visibly unsolved, not only on disk.
      const shown = await waitFor(
        async () => {
          const tree = await oracleRead("Finder").catch(() => "");
          return tree.includes("draft-v1.txt") && !tree.includes("final-report.txt");
        },
        { timeoutMs: 8000, everyMs: 500 },
      );
      if (!shown) throw new Error("Finder did not show the new finder-task folder");
    },
    async verify() {
      if (!fs.existsSync(finderDir)) return { ok: false, detail: "no finder-task folder yet" };
      const names = fs.readdirSync(finderDir).sort();
      const ok = names.includes("final-report.txt") && !names.includes("draft-v1.txt") && names.length === 3;
      return { ok, detail: `folder holds ${names.join(", ")}` };
    },
    async teardown() {
      await closeFinderWindow("finder-task");
    },
  },
  {
    id: "textedit-setting",
    app: "TextEdit",
    kind: "text",
    prompt: "In TextEdit's settings, set the format for new documents to Plain Text, then close the settings window.",
    async setup() {
      await closeBenchTextEdit();
      await sh("defaults", ["write", "com.apple.TextEdit", "RichText", "-bool", "true"]);
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(scratchPath, "Scratch document for the settings task.\n");
      await openTextEdit(scratchPath);
    },
    async verify() {
      const value = await sh("defaults", ["read", "com.apple.TextEdit", "RichText"]).catch(() => "missing");
      const ok = value === "0";
      return { ok, detail: `RichText is ${value}` };
    },
    async teardown() {
      await osascript('tell application "TextEdit" to close (every window whose name is not "scratch.txt")').catch(() => {});
      await closeBenchTextEdit();
    },
  },
  {
    id: "form",
    app: "Bench Fixture",
    kind: "text",
    prompt: `In the Bench Fixture app's Bench Form window, add this person and submit the form: ${describePerson(PEOPLE[0])}.`,
    async setup() {
      await launchFixture("form", formOut);
    },
    async verify() {
      const records = readJsonLines(formOut);
      const ok = sameRecords(records, PEOPLE.slice(0, 1));
      return { ok, detail: `${records.length} record(s): ${JSON.stringify(records)}` };
    },
    teardown: quitFixture,
  },
  {
    id: "canvas",
    app: "Bench Fixture",
    kind: "pixel",
    prompt: "The Bench Fixture app's Bench Canvas window shows numbered tiles. Click the tile numbered 7, then the tile numbered 3.",
    async setup() {
      await launchFixture("canvas", canvasOut);
    },
    async verify() {
      const tiles = readJsonLines(canvasOut).map((r) => r.tile);
      const ok = tiles.length === 2 && tiles[0] === 7 && tiles[1] === 3;
      return { ok, detail: `clicked ${JSON.stringify(tiles)}` };
    },
    teardown: quitFixture,
  },
  {
    // The replay baseline: the same form three times in one conversation.
    // Round trips for the second and third records show what a repeat costs
    // today; durable scripts should bring that toward one call.
    id: "form-repeat",
    app: "Bench Fixture",
    kind: "text",
    prompt: `In the Bench Fixture app's Bench Form window, add this person and submit the form: ${describePerson(PEOPLE[0])}.`,
    followUps: PEOPLE.slice(1).map((p) => `Do the same for another person: ${describePerson(p)}.`),
    async setup() {
      await launchFixture("form", formOut);
    },
    async verify() {
      const records = readJsonLines(formOut);
      const ok = sameRecords(records, PEOPLE);
      return { ok, detail: `${records.length} record(s): ${JSON.stringify(records)}` };
    },
    teardown: quitFixture,
  },
];
