# Backend presentation

A plain-English explanation of the Fastermall backend, with an audit. Written for people who don't write code.

- **`Fastermall_Backend_Explained.pptx`**: the 31-slide deck. The speaker notes hold the technical details (file names, routes) for developers.
- **`images/`**: every diagram as a PNG (for slides and chat) and an SVG (sharp at any size).

| Image | Shows |
| --- | --- |
| `01-restaurant-analogy` | The backend as a restaurant kitchen: apps, backend, database, outside services |
| `02-who-uses-it` | The five roles and what each can do |
| `03-architecture-map` | Apps, front-door checks, the 18 modules, and outside services |
| `04-request-journey` | The 10 checkpoints every request passes |
| `05-order-lifecycle` | An order from basket to doorstep, with expiry, cancellation and delivery windows |
| `06-payment-flow` | How a Paystack payment is started, confirmed and checked |
| `07-delivery-flow` | Delivery job steps, the handover code, who gets jobs, partner pay |
| `08-laundry-flow` | The 13 laundry stages and multi-vendor rules |
| `09-partner-onboarding` | How a new delivery partner applies and gets started |
| `10-event-bus` | How modules tell each other news |
| `11-data-map` | The 42 database tables in six groups |
| `12-security-layers` | The layers of protection |
| `13-audit-scorecard` | Audit grades for nine areas |
| `14-deploy-flow` | How new code goes live |

The audit reflects `main` at commit `c26445c` (13 Nov 2026): 708/708 tests passing, type check clean, `npm audit` (production dependencies) reporting 16 known vulnerabilities.

## Regenerating

`source/diagrams.js` draws the images and `source/deck.js` builds the deck. They need `sharp` and `pptxgenjs`, which aren't backend dependencies, so install them in a separate folder:

```bash
node source/diagrams.js presentation
node source/deck.js presentation <path-to-apply_theme.js>
```
