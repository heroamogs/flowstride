# Core Flowstride workflows

Flowstride can call an API, extract data from its response, use that data in a browser, and verify the application outcome in the same `.flow` test. It also supports table/cell targeting, browser sessions, microphone input and visual manual testing.

The examples below use the normal Flowstride CLI. Their small HTTP server is a local demonstration application; it does not replace the test runner.

For a first run, use the [bundled practice app](examples/practice-app/README.md). It starts automatically for the starter flows created by `npx flowstride init`.

## Choose a workflow

| Workflow | What you will do | Availability |
| --- | --- | --- |
| [API + UI in one test](examples/native-workflows/api-and-ui/README.md) | Create a user through an API, sign in through the browser, then verify backend state | Open-source and Cloud engines; Chromium, Firefox, WebKit |
| [API + UI + email OTP](examples/native-workflows/api-ui-otp/README.md) | Use FlowMail to retrieve a delivered code and complete application authentication | Cloud; a supported inbox and an application that sends OTP email |
| [iFrames](examples/native-workflows/iframes/README.md) | Find a readable child-frame target, assert inside an explicit frame, and extend an action with a focused plugin | Open-source and Cloud engines; Chromium, Firefox, WebKit |
| [Audio-to-text workflows](examples/native-workflows/audio-to-text/README.md) | Inject microphone audio, drive recording controls and check the resulting transcript | Open-source and Cloud engines; audio injection requires Chromium |
| [Tables and cells](examples/native-workflows/tables-and-cells/README.md) | Search a table, click a specific row action, extract a cell and reuse its value on another page | Open-source and Cloud engines; Chromium, Firefox, WebKit |
| [Variables, reuse and saved sessions](examples/native-workflows/variables-and-reuse/README.md) | Reuse generated/extracted values, understand scope, and restore saved browser state | Open-source and Cloud engines; Chromium, Firefox, WebKit |
| [Manual testing](examples/native-workflows/manual-testing/README.md) | Load a design, execute its steps, record defects/results and reopen saved history | Open-source and Cloud engines; local Manual Workspace |

Start with the [shared setup](examples/native-workflows/README.md). It installs Flowstride with `npm i flowstride`, copies the examples already included in the package, and starts a loopback-only demo application. No separate starter download is required.

## Flowstride and Flowstride Cloud

Flowstride works locally without an account. To connect Cloud, run:

```sh
npx flowstride login
```

Use your Cloud developer token when prompted and accept the authenticated engine installation when offered. Cloud has free accounts; availability and usage allowances depend on the workspace feature and plan. Email OTP retrieval uses the Cloud FlowMail service. The other local examples do not need a Cloud service connection.

The public CLI selects a compatible, authorized Cloud engine when available and falls back to the open-source engine. A Cloud-only command still requires its Cloud service prerequisites.

## Reading and running the examples

- `flows/` contains runnable examples for the shared demo application.
- `negative/` contains deliberate failures. Run them individually and expect a nonzero exit code.
- `templates/` contains application-specific workflows. Configure the documented application, credentials and selectors before using them.
- Manual designs are JSON files; a human performs their actions and records the result.

Run the named file from its chapter. Running the whole example tree also discovers intentional failures and service-dependent templates.

Each chapter explains its prerequisites, expected result, negative check and limitations. For browser profiles, native assertions, network mocking, downloads, traces/HAR, accessibility and component testing, use [NATIVE_BROWSER.md](NATIVE_BROWSER.md). For CI, reports and games, use [NATIVE_CI.md](NATIVE_CI.md).

## Call a JavaScript or TypeScript helper

Write the scenario in Flowstride (FS) using a `.flow` file. Put the JS or TS calculation in a helper and import its named export under `Feature`. Bare helper paths start in `helpers/` or the configured `helpersDir`. Paths beginning with `./` or `../` start at the flow's directory.

Call `flow.call generateEmail() as "signupEmail";` inside a scenario to capture the result. Read it as `@signupEmail` in the same file. Use `as global "signupEmail"` and `@global[signupEmail]` for a value shared within one worker process. Use a handoff for dependencies between files and workers.

Call `flow.call checkCatalogPrices(page, "@cars");` when the helper should receive the active browser page. Other arguments are JSON values. The quoted fragment form `flow.call "steps/customer.flowpart";` includes a sequence of FS commands.

## JavaScript and TypeScript fixtures

Use a fixture when a scenario needs a resource that Flowstride should set up and release, such as test records, browser profiles, or a local service. Export a named function from a project helper and import it under Feature. Flowstride searches the project's helper directory, which defaults to `helpers/`.

For example, put this function in `helpers/workspaces.js` and use your test application's workspace endpoints.

```javascript
export async function testWorkspace({ baseURL, signal, defer, profile }) {
  const response = await fetch(new URL('/api/test/workspaces', baseURL), {
    method: 'POST',
    signal
  })
  if (!response.ok) throw new Error('Could not create a test workspace')
  const { id } = await response.json()

  defer(async cleanupSignal => {
    const url = new URL('/api/test/workspaces/' + encodeURIComponent(id), baseURL)
    const result = await fetch(url, { method: 'DELETE', signal: cleanupSignal })
    if (!result.ok && result.status !== 404) throw new Error('Could not remove the test workspace')
  })

  profile('admin')
  profile('member')
  return { id }
}
```

```flow
Feature: Isolated workspace sessions
import { testWorkspace } from "workspaces.js";

Scenario: Open the workspace from two test sessions
  Given "Create a workspace and two browser profiles"
    flow.fixture.use testWorkspace() as "workspace";
  When "Visit the workspace from each profile"
    flow.browser.use {"name":"admin"};
    flow.open "/workspaces/@workspace.id";
    flow.browser.use {"name":"member"};
    flow.open "/workspaces/@workspace.id";
  Then "Confirm the workspace page is visible"
    flow.expect visible "Workspace";
```

- `flow.fixture.use` starts a fresh fixture each time the command runs in Given, including on retry. Pass JSON arguments inside the parentheses, the same as with `flow.call`. The context is passed automatically as the first argument. TypeScript helpers can import `FixtureContext` from the installed Flowstride package.
- A scenario fixture receives `attempt`, starting at `1` and incrementing on retry. Worker fixtures are shared across attempts and omit it.
- `as "workspace"` makes returned JSON available through `@workspace` during that scenario attempt. Profile declarations create independent browser contexts. Switch with `flow.browser.use`, then sign in or call browser helpers using the active page.
- `flow.fixture.worker` reuses a fixture with the same module, export and arguments within one worker, including across files assigned to it. Its result can be JSON or undefined. Use worker scope for resources that are safe to reuse, such as a read-only service. Browser profiles and mutable per-test data belong to scenario-attempt fixtures.
- Register cleanup immediately after acquiring each resource. Flowstride runs registered callbacks in reverse order after partial setup, success, failure or cooperative cancellation. Attempt cleanup runs before retry. A worker fixture that fails during setup releases its partial resources in the current attempt. A successfully initialized worker fixture is released when its worker finishes.
- Pass the setup signal and the cleanup callback's own signal to asynchronous operations. Make releases safe to repeat after an interrupted run. The terminal and dashboard logs report cleanup separately. The CI summary includes `fixtureCleanups` and fails the run if teardown fails.

## Dependencies between test files

Use `flow.handoff.publish` in a producer file and `flow.handoff.receive` in a consumer file to pass test data within one run. The scheduler leaves the consumer waiting while its prerequisites run. Other ready files can use the available Pro workers. A handoff is released to consumers after the producer file passes, including any retries.

Run the bundled examples to watch an admin retry, a user wait for the new account, and cleanup after sign-in. [Advanced practice examples](examples/practice-app/README.md#advanced-examples)

For an admin-to-member test, an application helper can create a test account and register its deletion with `defer(release, { handoff: "approvedMember" })`. Call `defer(release, { handoff: "approvedMember" })` as soon as creation succeeds. Pass the fixture's setup signal to the create operation and the cleanup callback's signal to the delete operation.

```javascript
export async function createTestAccount({ baseURL, signal, defer }) {
  const response = await fetch(new URL('/api/test/accounts', baseURL), {
    method: 'POST',
    signal
  })
  if (!response.ok) throw new Error('Could not create the test account')
  const account = await response.json()

  defer(async cleanupSignal => {
    const url = new URL('/api/test/accounts/' + encodeURIComponent(account.id), baseURL)
    const result = await fetch(url, { method: 'DELETE', signal: cleanupSignal })
    if (!result.ok && result.status !== 404) throw new Error('Could not delete the test account')
  }, { handoff: 'approvedMember' })

  return account
}
```

In the producer file, assign and verify the account's permission using your test application's API.

```flow
Feature: Approve a test account
import { createTestAccount } from "accounts.js";

Scenario: Grant approval permission
  Given "Create a fresh account"
    flow.fixture.use createTestAccount() as "account";
  When "Grant the approval role"
    flow.post "/api/test/accounts/@account.id/grant-approval";
    flow.expect status "200";
  Then "Confirm permission and prepare the handoff"
    flow.get "/api/test/accounts/@account.id";
    flow.expect resBody "canApprove" equals "true";
    flow.handoff.publish {
      "name": "approvedMember",
      "value": {"id":"@account.id","email":"@account.email"},
      "credentials": {"password":"@account.password"}
    };
```

In a separate consumer file, put `flow.handoff.receive` in Given. The example binds account data and credentials under separate names.

```flow
Feature: Confirm the member can approve orders

Scenario: Sign in using an isolated browser session
  Given "Receive the confirmed account"
    flow.handoff.receive {"name":"approvedMember","as":"member","credentialsAs":"login"};
    flow.open "/login";
  When "Sign in with the issued test credentials"
    flow.type input "Email" "@member.email";
    flow.passcode input "Password" "@login.password";
    flow.click button "Sign in";
  Then "Verify the approval permission"
    flow.expect visible "Can approve orders";
```

- Run the consumer file directly to include its producer and any transitive prerequisites automatically. Producers are discovered under the configured test directory for a file inside that directory, or under the selected file's directory otherwise. A directory run resolves dependencies within that directory. A tag selection can add the required producer scenarios.
- Each handoff name has one producer and publishes one value. A file can read several handoffs. Flowstride validates missing or duplicate producers and circular dependencies before running tests. CI assigns a connected dependency chain to one shard.
- A failed attempt releases its account before retry. A successful producer's retained cleanup stays registered through the last consumer retry and runs as the coordinated run finishes. A terminal producer failure shows the consumer as **Blocked** with the prerequisite's name.
- Keep passwords out of `value` and refer to fixture values in `credentials`. The coordinator stores a protected reference in memory and delivers secret values only to files with a `credentialsAs` binding. Those bindings last for one scenario attempt. Credential values are masked in Flowstride reports. Handoff runs disable screenshots, video, traces, HAR, DOM snapshots, persisted sessions, and native commands that would save browser evidence.

The maintained full reference is at [docs.flowstride.io](https://docs.flowstride.io/).

## Share helpers with existing Playwright suites

A `.flow` file and a Playwright spec can import the same JavaScript or TypeScript helper. See the [runnable discount example](examples/native-workflows/playwright-reporting/README.md) and the [Playwright reporting guide](NATIVE_CI.md#report-existing-playwright-test-suites) for how to view both results together.

## Scoped browser workflows

The [customer tables and schedule cards lesson](examples/native-workflows/scoped-browser/README.md) runs locally. It covers parent traversal, named columns, filtered rows, stable keys for a changing list, and per-row assertion diagnostics.
