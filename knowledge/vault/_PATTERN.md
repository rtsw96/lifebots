# The Permanent Layer

> The philosophy behind this vault. The operational rules in `CLAUDE.md` come from it. Refer back to
> it when a judgement call needs it. Do not modify.

A pattern for a personal knowledge base that compounds: atomic, linked, durable notes, maintained by
an AI agent, built only from what you choose to keep.

---

## The core idea

Most of what we learn does not compound. We read an article, have a good conversation, work
something out, and a month later it is gone, or buried in a chat history we will never search.
Each time a similar question comes up, we rebuild the understanding from scratch.

The Permanent Layer fixes this. It is a small set of atomic, linked notes that hold the *durable*
part of what you learn: how things work, the principles behind them, and the stable facts about the
things you care about. Everything else (news, to-do lists, today's numbers, passing opinions) stays
where it is.

The agent is what makes this viable. The bookkeeping of a well-linked knowledge base (updating
every related note when a new insight lands, flagging contradictions, keeping maps current) is why
people abandon their notes. The agent does not get bored. It can touch fifteen notes in one pass.
The vault stays maintained because maintenance is nearly free.

---

## The temporal vs. permanent split

The one discipline that makes or breaks the system is deciding what belongs here. The test is one
question:

> **Will this still teach me something in five years?**

If yes: permanent. If no: leave it out.

| Temporal (leave it out) | Permanent (write it down) |
|---|---|
| This week's weather forecast | Seasons come from Earth's tilt, not its distance from the Sun |
| A recipe's exact timings for my oven | Wild-yeast starters ferment more slowly than commercial yeast |
| Today's exchange rate | A strong home currency makes imports cheaper and exports harder |
| A news story about a study | Single studies often fail to replicate; look for systematic reviews |
| My score in last night's quiz | Retrieval practice beats rereading for long-term memory |

If something is mixed, partly durable and partly current, **separate the principle from the
instance**. Write the principle as a permanent note. Let the instance go. The principle compounds;
the instance dies on schedule.

---

## Architecture

Three layers:

**1. Raw sources.** Articles, book excerpts, transcripts, your own notes, Q&A conversations you
chose to file. Immutable. The agent reads them but never modifies them. They live in `raw/`,
verbatim.

**2. The notes.** Atomic notes, maps (MOCs), the index, the log. The agent writes and links them;
you read, approve, edit or delete them.

**3. The rules.** `CLAUDE.md` encodes the conventions: how notes are structured, what links to
what, the voice, and when *not* to write a note.

---

## The two kinds of atomic notes

This distinction matters more than any other.

**Concept notes** are portable. They describe how something *works*, not what is true of one
specific thing:

- *Seasons come from Earth's tilt, not its distance from the Sun*
- *Retrieval practice beats rereading for long-term memory*
- *Compound growth looks flat for a long time, then steep*
- *Feedback loops either stabilise a system or run it away*

They apply to situations you have not met yet. They compound across subjects and decades.

**Entity notes** are true about one specific thing (a person, place, organisation, product, book,
event) but stable:

- *The Moon keeps one face towards Earth*
- *The Roman Republic was governed by two consuls elected each year*

They change only when the thing itself changes, so they carry an `as_of` date and get checked now
and then.

The temptation is to weld them: *"The Moon keeps one face towards us because tidal forces slowed
its spin until it locked."* That is two ideas stapled together. Next time you meet tidal locking
elsewhere (a moon of Jupiter, a planet around another star), the concept note *"Tidal forces slow a
body's spin until it locks to its partner"* should surface, not the Moon-flavoured version.
**Separate the principle from the instance.** Always.

---

## Maps of Content

Maps (MOCs) are curated index notes that link to the atomic notes under them. Three kinds:

- **Concept maps** organise principles by domain: *Astronomy Basics*, *Bread Science*, *Learning & Memory*.
- **Entity maps** organise the facts about one thing, and link to the concept maps that explain it.
- **Theme maps** connect across domains: notes that share a pattern but not a subject (*Feedback Loops*, *Thresholds*). This is where serendipity lives: a note on tipping points in climate links to one on habits links to one on epidemics.

---

## The extraction discipline

This is the part everyone gets wrong, because it means saying no.

Most sources yield zero permanent notes. Most conversations yield zero. **That is the correct
yield, not a failure.** The compounding comes from the rare durable insight, not from atomising
every fragment.

- **After a conversation or a source you filed, ask one question:** *"What did this teach me that will still be true in five years?"* Usually nothing. Sometimes one thing. If one, write it and link it.
- **Synthesis sources yield more.** Your own long-form thinking, a primer you worked through: these are already half-extracted.
- **Every few months, look back.** *"What patterns keep coming up that I haven't written down?"* Patterns only show across several instances.
- **Don't try to import everything you've ever written.** You will burn out. Start from today: every filed source produces 0–3 notes.

---

## Operations

**Ingest.** A source lands in `To be filed/`. The agent archives it verbatim to `raw/`, applies the
5-year test, writes 0–3 notes as drafts, links them into the maps, updates the index and the log.

**Query.** Ask "what do I know about X?" The agent reads the index, drills into the notes and
answers with citations. Good answers can be filed back as new notes.

**Lint.** Monthly: contradictions, stale entity facts, orphan notes, welded notes, maps missing
members. Flag; don't auto-fix.

---

## House style

- Every note ends with a *so what*: why it matters to you.
- Mechanisms, not vague claims: *"X causes Y through Z"*, not *"X is important"*.
- Every claim of fact cites a source; every mechanism is reasoned.
- One idea per note. If the title needs "and", consider splitting.
- The title is the idea, not the topic: *"Retrieval practice beats rereading"*, not *"Memory"*.
- Link densely. A note with no links is either premature or not really atomic.

---

## What this system is not

- Not a note-taking app for everything. Only the durable part goes in.
- Not a news archive or a to-do list.
- Not a place for current opinions. Those die on the next headline.
- Not a productivity hack. It feels pointless for the first 50 notes. Around 200, the links start surfacing connections you didn't expect. The compounding is real but back-loaded.

---

## Why this works

The tedious part of a knowledge base is not the reading or the thinking; it is the bookkeeping.
The agent removes that cost. The discipline of *what gets written* (the 5-year test, the
principle/instance split) stays yours and cannot be delegated. The discipline of *how it stays
linked and consistent* is the agent's. Together they keep the vault alive past month three, which
is when most personal knowledge bases die.
