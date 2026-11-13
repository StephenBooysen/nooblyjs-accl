# nooblyjs-accl

A monorepo of NooblyJS accelerators. Each folder `nooblyjs-accelerator-*` is one accelerator with its own
`package.json`, tests and `.claude/` steering.

| Accelerator | What it is |
| --- | --- |
| `nooblyjs-accelerator-infrastructure` | Noobly Cloud: VMs, apps, databases and buckets on GCP and AWS (mock cloud so far). |
| `nooblyjs-accelerator-customers` | A library for customer data, marketing and a contact-centre status page. |
| `nooblyjs-accelerator-commerce` | Ecommerce, warehouse and delivery applications in one server. |
| `nooblyjs-accelerator-analytics` | A metrics dashboard screen (specified, not started). |
| `nooblyjs-accelerator-studio` | The AI Digital Studio: brief-to-media production (specified, not started). |

Start here: **`.claude/steering/monorepo.md`** (how the parts relate, what works, open items).

Root launcher: `app.js` loads the infrastructure accelerator at `/infrastructure`. It does not start yet, because
`passport` is missing from the root `package.json` (see the steering doc, §4).

Run a script in every accelerator: `node scripts/run-all.js <script>` (for example `test`, or `start --parallel`).
