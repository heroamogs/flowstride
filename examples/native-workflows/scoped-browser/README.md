# Test customer tables and schedule cards

From the repository root, install dependencies, build the CLI and start the example server.

```sh
npm ci
npm run build
node examples/native-workflows/shared/server.mjs
```

From a second terminal in the same checkout, run the five passing files. The example server binds to localhost and each page visit starts with fresh data.

```sh
export BASE_URL=http://127.0.0.1:4107
node dist/cli/index.js run examples/native-workflows/scoped-browser/flows
```

| File | What to watch |
| --- | --- |
| [customer-rows.flow](flows/customer-rows.flow) | Find Jason by his email, ascend to his row, then check every row's structure using zero-based indexes. |
| [save-after-sort.flow](flows/save-after-sort.flow) | Save Jason once. The page replaces the rows and moves him to the top before FS checks his status. |
| [pending-columns.flow](flows/pending-columns.flow) | Read the balance under **Due** and check the approval button for each **Pending** record. |
| [approve-original-users.flow](flows/approve-original-users.flow) | Approvals remove and reorder rows. FS remembers the original user IDs so each user receives one approval. |
| [booking-link.flow](flows/booking-link.flow) | Wait for a schedule card, then inspect the same booking link three times using `current`. |

For the failure lesson, run this file on its own. In the dashboard, expand the failed assertion. Inspect its row, column, expected substring and observed email. Add `--ci` to either run command for a terminal result and a machine-readable summary.

```sh
node dist/cli/index.js run examples/native-workflows/scoped-browser/negative/fourth-email.flow
```

This run should fail on row 4 of 4. The **Email** cell contains `tim.example.com` and the assertion requires `@`.
