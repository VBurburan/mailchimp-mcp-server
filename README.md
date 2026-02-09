# Mailchimp MCP Server for Path2Medic

A custom MCP server that lets Claude create, write, and manage Mailchimp email campaigns directly from chat.

## What Claude Can Do With This

| Tool | What it does |
|------|-------------|
| `mailchimp_list_audiences` | List your audiences and subscriber counts |
| `mailchimp_list_campaigns` | List recent campaigns (drafts, sent, scheduled) |
| `mailchimp_create_campaign` | Create a new draft campaign |
| `mailchimp_set_content` | Set the HTML email content |
| `mailchimp_send_test` | Send a test/preview email to your inbox |
| `mailchimp_send_campaign` | Send to full audience (irreversible) |
| `mailchimp_schedule_campaign` | Schedule for a future date/time |
| `mailchimp_get_report` | Get open/click/bounce stats for sent campaigns |
| `mailchimp_delete_campaign` | Delete a draft campaign |

## Typical Workflow

1. You: "Write an email announcing the Under the Hood book launch"
2. Claude: writes the HTML, creates a campaign draft, sets the content
3. Claude: sends you a test email to preview
4. You: review it in your inbox, say "looks good, send it"
5. Claude: sends to your full list

---

## Setup (One-Time, ~10 Minutes)

### Step 1: Get Your Mailchimp API Key

1. Log into [mailchimp.com](https://mailchimp.com)
2. Click your profile icon → **Account & billing**
3. Go to **Extras → API keys**
4. Click **Create A Key**
5. Copy the key — it looks like: `abc123def456ghij-us14`
   - The part after the dash (`us14`) is your data center

### Step 2: Deploy to Vercel

1. Push this folder to a new GitHub repo (e.g., `mailchimp-mcp-server`)
2. Go to [vercel.com](https://vercel.com) → **New Project** → Import the repo
3. In the Vercel project settings, add an **Environment Variable**:
   - Name: `MAILCHIMP_API_KEY`
   - Value: your full API key (e.g., `abc123def456ghij-us14`)
4. Deploy

Your MCP endpoint will be at: `https://your-project-name.vercel.app/mcp`

### Step 3: Connect to Claude

1. Go to [claude.ai](https://claude.ai) → **Settings** → **Integrations / Connectors**
2. Add a new **Custom MCP Server**:
   - **Name**: Mailchimp
   - **URL**: `https://your-project-name.vercel.app/mcp`
3. Save

That's it. Claude now has access to your Mailchimp account.

---

## Security Notes

- Your API key is stored as a Vercel environment variable — never in code
- The MCP endpoint is only accessible to your Claude account through the MCP connection
- Campaign sends require explicit confirmation (Claude will always ask before sending)
- Test emails are sent first by default

## Files

```
mailchimp-mcp-server/
├── api/
│   └── mcp.ts          # Vercel serverless function (main server)
├── src/
│   ├── index.ts         # Standalone Express server (alternative)
│   └── services/
│       └── mailchimp-client.ts  # API client
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```
