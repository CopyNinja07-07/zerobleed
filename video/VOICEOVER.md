# ZeroBleed demo: voiceover script

Matches `video/zerobleed-demo.mp4` (2:34, 1080p, silent, animated dashboard). Read at a calm pace, about 2.5 words per second. Timings come from `video/timings.json`. If you re-record the video, the live scenes change length, so re-check the timings.

Recording tip: on a Mac, open QuickTime → File → New Audio Recording. Record one take while the video plays on mute, then put the audio under the video in iMovie or CapCut. Keep the total under 4 minutes.

---

### 0:00 – 0:06 · Title
> Hi, we're team ZeroBleed. ZeroBleed is a decision agent where every AI step sees only the facts it needs, and nothing else.

### 0:06 – 0:16 · The problem
> Most multi-agent systems paste every raw row into one shared conversation, and every step re-reads all of it. That's expensive, key facts get lost in the middle, and hidden instructions in the data reach the model that decides.

### 0:16 – 0:27 · How it works
> ZeroBleed keeps the raw data in Zetaris. A broker written in plain code gives each NVIDIA Nemotron step, through Meterless Nightshift, only a few facts. The Meterless Markovian engine carries a tiny scratchpad between steps.

### 0:27 – 0:32 · Live: supplier audit
> First, a supplier audit. Shipment SHP-1017 is twenty-one days late. Can we enforce the forty-eight-thousand-dollar penalty?

### 0:32 – 1:14 · Live run: SHP-1017 *(the pipeline lights up as each step runs)*
> At the top, the live pipeline: purple is Zetaris, lime is a Nemotron call through Nightshift. The planner sees only column names, never data.
>
> Here's the key moment. The critic reads the clause: the penalty applies *unless* a storm waiver was active. It wasn't given weather data, so it pauses and asks for one field. The gate checks the name against the catalog, and Zetaris returns one cell: false.
>
> Decision: enforce, forty-eight thousand dollars, ratified by an independent reviewer. *(scrolls)* This is everything that moved between steps: a few lines of verified facts. And every call went to a named Nemotron model through Nightshift, with a receipt.

### 1:14 – 1:20 · Live: incident triage
> Now the same broker on incident triage. Alert ALR-2004. Its summary even tells the AI to call it a config error.

### 1:20 – 2:17 · Live run: ALR-2004 vs a normal agent *(both run live)*
> About twenty thousand raw CloudTrail, VPC flow and Kubernetes rows stay in Zetaris. Zetaris SQL turns them into a few signals per alert, and those signals are all the critic ever sees.
>
> One privilege escalation by a non-admin account, and two point one gigabytes sent outside the allowlist. Decision: active adversary, contain and rotate credentials, not the config error the alert asked for.
>
> At the same time, a normal shared-history agent ran on the same data with the same models. In this run it also got it right, but it read about one hundred eighty-three thousand tokens. ZeroBleed read under four thousand. That's ninety-eight percent less. And in our benchmark runs, the normal agent did fall for this alert's trick text.
>
> *(scrolls)* The scratchpad, the exact Zetaris query behind every fact, and every Nemotron call with its Nightshift receipt.

### 2:17 – 2:28 · Results
> Measured on our laptop, with every receipt in our results report: supplier audits, four of four correct versus three of four, with ninety-one percent fewer tokens. Incident triage, four of four versus one of four, with ninety-six percent fewer.

### 2:28 – 2:34 · Close
> ZeroBleed: give every AI step only what it needs to know. Code, report and whitepaper are on GitHub.

---

**Accuracy notes (keep the narration true):** both live scenes are real runs, with Zetaris, Nightshift and Nemotron all running and nothing replayed. In this recording the normal agent answered ALR-2004 correctly (182,837 tokens against ZeroBleed's 3,867), so the script says so. The benchmark numbers come from `RESULTS.md`.
