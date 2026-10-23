# ZeroBleed demo: voiceover script

Matches `video/zerobleed-demo.mp4` (2:56, 1080p, silent). Read at a calm pace, about 2.5 words per second. Timings come from `video/timings.json`. If you re-record the video, the live scenes change length, so re-check the timings.

Recording tip: on a Mac, open QuickTime → File → New Audio Recording. Record one take while the video plays on mute, then put the audio under the video in iMovie or CapCut. Keep it under 4 minutes.

---

### 0:00 – 0:06 · Title
> Hi, we're team ZeroBleed. ZeroBleed is a decision agent where every AI step sees only the facts it needs, and nothing else.

### 0:06 – 0:16 · The problem
> Most multi-agent systems paste every raw row into one shared conversation, and every step re-reads all of it. That's expensive, key facts get lost in the middle, and any instruction hidden in the data reaches the model that makes the decision.

### 0:16 – 0:26 · How it works
> ZeroBleed keeps the raw data in Zetaris. A broker written in plain code gives each NVIDIA Nemotron step, through Meterless Nightshift, only two to six facts. The Meterless Markovian engine carries a scratchpad under five hundred characters between steps.

### 0:26 – 0:32 · Live: supplier audit
> First, a supplier audit. Shipment SHP-1017 is twenty-one days late. Can we enforce the forty-eight-thousand-dollar penalty?

### 0:32 – 1:28 · Live run: SHP-1017 *(the dashboard is working live)*
> The planner sees only Zetaris column names, never data. Each worker gets a tiny card.
>
> Here's the key moment. The critic reads the clause: the penalty applies *unless* a storm waiver was active. It wasn't given weather data, so instead of guessing, it pauses and asks for one field: force_majeure.waiver_declared. The broker checks that the name is in the catalog, and Zetaris returns one cell: false.
>
> With that one fact, the critic verifies, and Nemotron Ultra decides: enforce, forty-eight thousand dollars. An independent reviewer ratifies it, and the auditor can approve or send it back.
>
> *(scrolls to scratchpad)* This is everything that moved between steps: a few lines of verified facts, not a conversation.
>
> *(scrolls to model calls)* Every call went through Meterless Nightshift to a named Nemotron model, and each has a Nightshift receipt you can look up.

### 1:28 – 1:34 · Live: incident triage
> Now the same broker on a different problem: incident triage. Alert ALR-2004. Its summary even tells the AI to call it a config error.

### 1:34 – 2:41 · Live run: ALR-2004 vs a normal agent *(both run live, side by side)*
> About twenty thousand raw CloudTrail, VPC flow and Kubernetes rows stay in Zetaris. Zetaris SQL turns them into per-alert signals. The critic sees those signals, never a raw log line.
>
> The strategist asks for exactly the facts the policy needs: one privilege escalation by a non-admin principal, and two point one gigabytes sent outside the allowlist. Decision: active adversary, contain and rotate credentials.
>
> On the right, a normal shared-history agent ran on the same data with the same models. In this run it also got the answer right, but it read about one hundred eighty-three thousand tokens to do it. ZeroBleed read about forty-seven hundred. Across our benchmark runs, the normal agent fell for this trick text and recommended a rollback.
>
> *(scrolls)* Again: the scratchpad, the evidence trail with the exact Zetaris query behind each fact, and every Nemotron call with its receipt.

### 2:41 – 2:51 · Results
> Measured on our laptop, with every receipt in our results report: supplier audits, four of four correct versus three of four, with ninety-one percent fewer tokens. Incident triage, four of four versus one of four, with ninety-six percent fewer tokens.

### 2:51 – 2:56 · Close
> ZeroBleed: give every AI step only what it needs to know. The code, the report and the whitepaper are on GitHub.

---

**Accuracy notes (keep the narration true):** the live runs in this video are real. Zetaris, Nightshift and Nemotron were all running, and nothing is replayed. In the ALR-2004 scene the normal agent answered correctly *in this recording*, so the script says so. The benchmark numbers come from `RESULTS.md`.
