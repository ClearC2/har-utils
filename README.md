# har-utils

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Language](https://img.shields.io/badge/Language-JavaScript-yellow?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Status](https://img.shields.io/badge/Status-Active-success)]()
[![License](https://img.shields.io/badge/License-Proprietary-red)]()

**har-utils** is a unified Node.js toolkit for building, generating, and executing **HTTP Archive (HAR)**–based API performance tests.  
It lets you reverse-engineer existing API calls, synthesize realistic test traffic, and measure performance at scale — all through a single interactive entry point.

---

## Table of Contents
- [Overview](#overview)
- [Project Structure](#project-structure)
- [Core Concepts](#core-concepts)
- [Usage](#usage)
  - [1) Build API Mappings (C Mode)](#1-build-api-mappings-c-mode)
  - [2) Generate Synthetic HARs (G Mode)](#2-generate-synthetic-hars-g-mode)
  - [3) Run Performance Tests (R Mode)](#3-run-performance-tests-r-mode)
- [Example Console Output](#example-console-output)
- [Example Workflow](#example-workflow)
- [Technical Details](#technical-details)
- [Example Results](#example-results)
- [License](#license)
- [Author](#author)

---

## Overview

| Mode | Script | Purpose |
|------|--------|---------|
| **C** | `build-har-config.js` | Learns your API behavior and creates entity mappings from SQL and HAR examples (interactive wizard). |
| **G** | `build-har-generator.js` | Generates realistic, randomized HAR traffic across one or more entities. |
| **R** | `har-runner.js` | Multi-threaded HAR player that replays calls, times them, and reports detailed performance metrics. |

Launch the suite and choose a mode interactively:

```bash
node har-utils.js
```

---

## Project Structure

```
har-utils.js              # Main entry point / launcher
├── build-har-config.js   # C Mode: Interactive API/entity mapping wizard
├── build-har-generator.js# G Mode: Synthetic HAR traffic generator
├── har-runner.js         # R Mode: Parallel HAR player & performance analyzer
└── build-har-common.js   # Shared utilities (CLI prompts, JSON helpers, randomization, etc.)
```

**Explanation:**
- **`har-utils.js`** — The controller. Presents the `(C / G / R / Q)` menu and launches each mode as a subprocess.  
- **`build-har-config.js`** — Builds API/entity mapping logic by learning from SQL schemas and HAR samples.  
- **`build-har-generator.js`** — Generates synthetic HARs that mimic real API behavior using randomized data.  
- **`har-runner.js`** — Executes HARs concurrently, measures latency, and outputs performance metrics.  
- **`build-har-common.js`** — Utility module used by all others (readline prompts, random generators, JSON handling, etc.).

---

## Core Concepts

- **Entity-driven testing:** Map your SQL entities to API payloads and routes, then reuse those mappings for test generation.  
- **HAR in / HAR out:** Learn from real HARs; generate new ones to simulate realistic traffic patterns.  
- **Threaded replay:** Multiple HARs can execute in parallel, each with independent thread pools.  
- **Performance analytics:** Collect global and per-URL statistics (average, p50, p90, p99, min/max, duplicate detection, etc.).

---

## Usage

### 1) Build API Mappings (C Mode)
```bash
node har-utils.js
# choose: C
```
Interactively analyze your SQL table definition and recorded HAR file to understand how database fields map to API payloads and routes.

---

### 2) Generate Synthetic HARs (G Mode)
```bash
node har-utils.js
# choose: G
```
Generate a new `.har` file containing randomized, schema-valid API requests for **CREATE** and **UPDATE** operations.  
Perfect for load testing, concurrency simulation, or synthetic dataset generation.

---

### 3) Run Performance Tests (R Mode)
```bash
node har-utils.js
# choose: R
```
Replay `.har` files in parallel (up to 4 at once, 1–10 threads per HAR), timing each call and summarizing results.

**Authentication behavior:**
- Provide **`authTokens.txt`** with one or more valid JWT authorization tokens.  
  If multiple tokens exist, a random token is chosen for each request to simulate different users.  
- Optionally include **`server_jwt.txt`** (a shared secret) to automatically refresh token expiration using HS256 signing.  
  Each request gets a freshly re-signed token with extended `exp`.

Each run reports total requests, success/error breakdowns, and detailed latency metrics (average, p50, p90, p99).

---

## Example Console Output

```
Executed requests: 1540
Average time     : 312.4 ms
Min/Max          : 42 / 987 ms
p50/p90/p99      : 210 / 490 / 802 ms
By method        : {"GET":320,"POST":1080,"PUT":140}
2xx/3xx/4xx/5xx  : 1520 / 0 / 18 / 2
```

---

## Example Workflow

1. Record actual API traffic in Chrome → save as `sample.har`.  
2. Export your entity’s SQL `CREATE TABLE` statement.  
3. Run **C Mode** to learn your mappings.  
4. Run **G Mode** to generate synthetic API traffic.  
5. Run **R Mode** to replay and measure real-world performance.

---

## Technical Details

- **Runtime:** Node.js 18+  
- **Built-ins used:** `fs`, `path`, `crypto`, `readline`, `child_process`, `os`  
- **Optional dependency:** [`randexp`](https://www.npmjs.com/package/randexp) for regex-based data synthesis  
- **Concurrency:** Up to 4 HARs in parallel, with 1–10 threads per HAR  
- **Metrics collected:** p50 / p90 / p99 latency, per-URL timing aggregates, per-method/status counts, duplicates, slowest endpoints

---

## Example Results

```
Global Summary
---------------
HARs executed     : 3
Total requests    : 4,215
Average latency   : 294.3 ms
p90 / p99         : 510 / 830 ms
2xx / 4xx / 5xx   : 4110 / 94 / 11
```

---

## License

Proprietary — © Clear C2, Inc. (internal use only)

---

## Author

**Allen Swope**  
Lead Developer — *Clear C2, Inc.*  
📧 [https://www.clearc2.com](https://www.clearc2.com)
