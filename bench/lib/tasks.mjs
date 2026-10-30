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
  oracleRun,
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
const tableOut = path.join(workDir, "table.jsonl");
const remoteOut = path.join(workDir, "remote.jsonl");
const signupOut = path.join(workDir, "signup.jsonl");
const userNotesPath = path.join(workDir, "user-notes.txt");

const NOTES = "Meeting notes\nAttendees: Alice, Carol\nAction: send the report on Friday\n";
const NOTES_EXPECTED = "Meeting notes\nAttendees: Alice, Carol\nAction: send the report on Thursday\nOwner: Bob";

const PEOPLE = [
  { name: "Ada Lovelace", email: "ada@example.com", department: "Engineering", newsletter: true },
  { name: "Grace Hopper", email: "grace@example.com", department: "Support", newsletter: false },
  { name: "Alan Turing", email: "alan@example.com", department: "Sales", newsletter: true },
  { name: "Katherine Johnson", email: "katherine@example.com", department: "Engineering", newsletter: false },
  { name: "Margaret Hamilton", email: "margaret@example.com", department: "Support", newsletter: true },
];

const COEXIST = { name: "Grace Hopper", email: "grace@example.com", department: "", newsletter: false };

// Ten records given in one prompt, as a pasted spreadsheet would be.
const BULK = [
  ["Mary Jackson", "mary.j@example.com", "Engineering", true],
  ["Dorothy Vaughan", "dorothy@example.com", "Support", false],
  ["Hedy Lamarr", "hedy@example.com", "Engineering", true],
  ["Radia Perlman", "radia@example.com", "Sales", false],
  ["Frances Allen", "fran@example.com", "Engineering", false],
  ["Barbara Liskov", "barbara@example.com", "Support", true],
  ["Annie Easley", "annie@example.com", "Sales", true],
  ["Evelyn Boyd", "evelyn@example.com", "Support", false],
  ["Joan Clarke", "joan@example.com", "Engineering", true],
  ["Edith Clarke", "edith@example.com", "Sales", false],
].map(([name, email, department, newsletter]) => ({ name, email, department, newsletter }));

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

// The dry run's scripted solve for one form record, through the oracle.
const FILL = `async function __fill(app, p) {
  const tree = async () => (await app.getAXState({ emit: false, disableDiffing: true })).split("\\n");
  const idx = (lines, re) => Number(lines.find((l) => re.test(l)).trim().split(" ")[0]);
  let t = await tree();
  await app.setValue(idx(t, /text field.*placeholder="Full name"/), p.name);
  await app.setValue(idx(t, /text field.*placeholder="name@example.com"/), p.email);
  if (p.department) {
    await app.click(idx(t, /pop up button/));
    await sleep(300);
    t = await tree();
    await app.click(idx(t, new RegExp('menu item "' + p.department + '"')));
  }
  t = await tree();
  if (/checkbox "Subscribe to newsletter" value="1"/.test(t.join("\\n")) !== p.newsletter) await app.click(idx(t, /checkbox "Subscribe/));
  await app.click(idx(t, /button "Submit"/));
  await sleep(300);
}`;

async function solveForm(people) {
  await oracleRun(`${FILL}; const __form = await gb.getApp("Bench Fixture"); for (const p of ${JSON.stringify(people)}) await __fill(__form, p); undefined;`, 120_000);
}

// A user typing in TextEdit while the agent works. Words go out only while
// the user's document is frontmost, so a tool that takes focus loses the
// user's text (and nothing is ever typed into another app).
const USER_WORDS = "the quick brown fox jumps over the lazy dog while the agent works in the background".split(" ");
const typist = { running: false, paused: false, typed: [], blocked: 0, done: null, word: null };

async function startTypist() {
  Object.assign(typist, { running: true, paused: false, typed: [], blocked: 0, word: null });
  typist.done = (async () => {
    for (let i = 0; typist.running; i++) {
      if (typist.paused) {
        await sleep(100);
        continue;
      }
      const word = USER_WORDS[i % USER_WORDS.length];
      const script = `tell application "System Events"
  set p to first process whose frontmost is true
  if name of p is "TextEdit" and name of front window of p is "user-notes.txt" then
    keystroke "${word} "
    return "typed"
  end if
  return name of p
end tell`;
      typist.word = osascript(script).catch(() => "error");
      const result = await typist.word;
      typist.word = null;
      if (result === "typed") typist.typed.push(word);
      else typist.blocked += 1;
      await sleep(250);
    }
  })();
}

// Verify runs before the agent too (to check the task starts unsolved), so
// it only pauses the user while it reads their document.
async function pauseTypist() {
  typist.paused = true;
  await typist.word;
}

async function stopTypist() {
  typist.running = false;
  await typist.done;
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
    // The replay baseline: the same form five times in one conversation.
    // Round trips for the later records show what a repeat costs today;
    // durable scripts should bring that toward one call.
    id: "form-repeat",
    app: "Bench Fixture",
    kind: "text",
    prompt: `In the Bench Fixture app's Bench Form window, add this person and submit the form: ${describePerson(PEOPLE[0])}.`,
    followUps: PEOPLE.slice(1).map((p) => `Do the same for another person: ${describePerson(p)}.`),
    maxTurns: 80,
    async setup() {
      await launchFixture("form", formOut);
    },
    async verify() {
      const records = readJsonLines(formOut);
      const ok = sameRecords(records, PEOPLE);
      return { ok, detail: `${records.length} record(s): ${JSON.stringify(records)}` };
    },
    solve: () => solveForm(PEOPLE),
    teardown: quitFixture,
  },
  {
    // Loops in one script versus one call per field.
    id: "bulk-entry",
    app: "Bench Fixture",
    kind: "text",
    maxTurns: 80,
    prompt: `In the Bench Fixture app's Bench Form window, add each of these ten people, in order, submitting the form once per person:\n${BULK.map((p, i) => `${i + 1}. ${describePerson(p)}`).join("\n")}`,
    async setup() {
      await launchFixture("form", formOut);
    },
    async verify() {
      const records = readJsonLines(formOut);
      const ok = sameRecords(records, BULK);
      return { ok, detail: `${records.length} record(s)${ok ? "" : `: ${JSON.stringify(records.slice(0, 3))}…`}` };
    },
    solve: () => solveForm(BULK),
    teardown: quitFixture,
  },
  {
    // A tree too big to read in one go: 200 rows, random per launch.
    id: "large-table",
    app: "Bench Fixture",
    kind: "text",
    prompt:
      "The Bench Fixture app's Bench Table window lists 200 items with a region and a quantity. Add up the Qty of every row whose Region is West, type the total into the Answer field, and click Submit.",
    async setup() {
      await launchFixture("table", tableOut);
    },
    async verify() {
      const records = readJsonLines(tableOut);
      const expected = records.find((r) => r.expected)?.expected;
      const answers = records.filter((r) => "answer" in r).map((r) => r.answer.trim());
      const ok = expected != null && answers.at(-1) === expected;
      return { ok, detail: `expected ${expected}, answered ${JSON.stringify(answers)}` };
    },
    async solve() {
      const expected = readJsonLines(tableOut).find((r) => r.expected).expected;
      await oracleRun(`const __t = await gb.getApp("Bench Fixture"); const __l = (await __t.getAXState({emit:false, disableDiffing:true, maxNodes: 4000})).split("\\n");
const __i = (re) => Number(__l.find((l) => re.test(l)).trim().split(" ")[0]);
await __t.setValue(__i(/text field.*placeholder="Answer"/), ${JSON.stringify(expected)}); await __t.click(__i(/button "Submit"/)); await sleep(300); undefined;`);
    },
    teardown: quitFixture,
  },
  {
    // Pixels only, like Citrix: small text, a row reached by scrolling right,
    // a record that loads two seconds after Open, and a tooltip panel that
    // takes key focus.
    id: "remote-desktop",
    app: "Bench Fixture",
    kind: "pixel",
    target: "",
    get prompt() {
      return `The Bench Fixture app's Bench Remote window is a remote desktop: it is only pixels. Find the row whose ID is ${this.target}, scroll right to that row's Open button and click it, wait for the record to load, then click Confirm.`;
    },
    async setup() {
      this.target = String(10_000_000 + Math.floor(Math.random() * 90_000_000));
      await launchFixture("remote", remoteOut, { target: this.target });
    },
    async verify() {
      const records = readJsonLines(remoteOut);
      const confirmed = records.filter((r) => r.confirmed).map((r) => r.confirmed);
      const ok = confirmed.length === 1 && confirmed[0] === this.target;
      return { ok, detail: `target ${this.target}, opened ${JSON.stringify(records.filter((r) => r.opened).map((r) => r.opened))}, confirmed ${JSON.stringify(confirmed)}` };
    },
    async solve() {
      const row = readJsonLines(remoteOut).find((r) => r.rows).rows.indexOf(this.target);
      // Layout from BenchFixture.swift: rows 26 pt from y 40, Open at x 1220,
      // fully scrolled right is an offset of 600 (1320 wide content, 720 window).
      await oracleRun(`const __r = await gb.getApp("Bench Fixture"); await __r.getScreenshot({emit:false}); const v = __r.view;
const title = v.height / v.scale - 480; const px = (x, y) => [Math.round(x * v.scale), Math.round((title + y) * v.scale)];
await __r.pressKey("Right Right Right"); await sleep(400);
await __r.click(px(1220 - 600 + 35, 40 + ${row + 1} * 26 + 13)); await sleep(2600);
await __r.click(px(70, 480 - 41)); await sleep(300); undefined;`);
    },
    teardown: quitFixture,
  },
  {
    // The answer arrives late, in a sheet, and the next step depends on it.
    id: "signup-recovery",
    app: "Bench Fixture",
    kind: "text",
    prompt:
      'In the Bench Fixture app\'s Bench Signup window, create an account with username "ada" and email ada.lovelace@example.com. If the username is taken, use the suggested username instead.',
    async setup() {
      await launchFixture("signup", signupOut);
    },
    async verify() {
      const records = readJsonLines(signupOut);
      const suggested = records.filter((r) => r.suggested).map((r) => r.suggested).at(-1);
      const created = records.filter((r) => r.created).map((r) => r.created);
      const ok = suggested != null && created.length === 1 && created[0].username === suggested && created[0].email === "ada.lovelace@example.com";
      return { ok, detail: `suggested ${suggested}, created ${JSON.stringify(created)}` };
    },
    async solve() {
      await oracleRun(`const __s = await gb.getApp("Bench Fixture"); const __tree = async () => (await __s.getAXState({emit:false, disableDiffing:true})).split("\\n");
const __i = (l, re) => Number(l.find((x) => re.test(x)).trim().split(" ")[0]);
let l = await __tree(); await __s.setValue(__i(l, /text field.*placeholder="Username"/), "ada"); await __s.setValue(__i(l, /text field.*placeholder="name@example.com"/), "ada.lovelace@example.com");
await __s.click(__i(l, /button "Create account"/)); await sleep(2600);
l = await __tree(); const sug = l.join("\\n").match(/Suggested username: (ada_\\d+)/)[1];
await __s.click(__i(l, /button "OK"/)); await sleep(300); l = await __tree();
await __s.setValue(__i(l, /text field.*Username/), sug); await __s.click(__i(l, /button "Create account"/)); await sleep(2600); undefined;`);
    },
    teardown: quitFixture,
  },
  {
    // The user keeps typing in TextEdit while the agent fills the form. A
    // tool that brings an app forward takes the user's keystrokes with it.
    id: "coexistence",
    app: "Bench Fixture",
    kind: "text",
    // No department: opening a pop-up menu in a background app takes the
    // user's keystrokes for as long as the menu is open (menu tracking is
    // system-wide), whatever the tool. That is filed for glovebox; this task
    // measures what the tool's own input method does to the user.
    prompt: `The user is typing in TextEdit and must not be interrupted. In the background, in the Bench Fixture app's Bench Form window, add this person and submit the form: name "${COEXIST.name}", email ${COEXIST.email}, not subscribed to the newsletter. Leave Department as it is.`,
    async setup() {
      await closeBenchTextEdit();
      await launchFixture("form", formOut);
      fs.writeFileSync(userNotesPath, "");
      await openTextEdit(userNotesPath);
      await osascript('tell application "TextEdit" to activate');
      await sleep(500);
      await startTypist();
      await sleep(1500);
    },
    async verify() {
      await pauseTypist();
      const records = readJsonLines(formOut);
      // TextEdit may capitalize the first word; case doesn't matter here.
      const text = (await osascript('tell application "TextEdit" to get text of document "user-notes.txt"').catch(() => "")).trim().toLowerCase();
      const expectedText = typist.typed.join(" ");
      const formOk = sameRecords(records, [COEXIST]);
      const textOk = text === expectedText && typist.blocked === 0;
      typist.paused = false;
      return {
        ok: formOk && textOk,
        detail: `form ${formOk ? "ok" : JSON.stringify(records)}; user typed ${typist.typed.length} words, ${typist.blocked} blocked while another app was in front${text === expectedText ? "" : `; their document reads ${JSON.stringify(text.slice(0, 80))}`}`,
      };
    },
    solve: () => solveForm([COEXIST]),
    async teardown() {
      await stopTypist();
      await osascript('tell application "TextEdit" to close (every document whose name is "user-notes.txt") saving no').catch(() => {});
      await closeBenchTextEdit();
      await quitFixture();
    },
  },
];
