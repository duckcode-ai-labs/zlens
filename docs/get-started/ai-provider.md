# Set up an AI provider

Ask, Notebook AI and the AI helpers in the saved query editor and App Studio need a
language model. Everything else works without one: notebooks, SQL and DQL
queries, saved queries, certification, Apps and lineage.

!!! note "Ask needs a model, even for certified answers"
    Ask uses the model to understand the question before it looks for a
    certified saved query. Without a provider, Ask answers **Couldn't run this
    query** and says that no AI model is configured.

## Pick a provider

1. Open **Settings → AI provider**.
2. Choose a **Provider**:
    - **Anthropic Claude**
    - **OpenAI**
    - **Google Gemini**
    - **Ollama — local**
    - **Custom OpenAI-compatible**
3. Under **How do you want to connect?**, choose one:
    - **Subscription**: sign in with your existing Claude or ChatGPT plan, with
      **Sign in with Claude** or **Sign in with ChatGPT**. No API key, and nothing
      billed per token.
    - **API key**: paste a key, or leave the field empty and set the
      environment variable instead (for example `ANTHROPIC_API_KEY`).
    - **Local** (Ollama): enter the **Host**, such as `http://localhost:11434`.
4. Optional: open **Advanced enterprise routing** to set a **Model**.
5. Click **Test, save & activate**.

When the test passes, the card at the top reads **Active ·** followed by the
provider and model. If the test fails, your previous provider stays active.

**Test unsaved values** checks the form without saving it.

## Run everything on your machine

With **Ollama — local**, questions and data never leave your network:

1. Install [Ollama](https://ollama.com) and pull a model.
2. In **Settings → AI provider**, choose **Ollama — local**.
3. Set **Host** to `http://localhost:11434` and, under **Advanced enterprise
   routing**, the **Model** name.
4. Click **Test, save & activate**.

## Embeddings (optional)

**Embeddings**, on the same page, decide whether a question can match a
metric by meaning or only by shared words.

- **Offline (Default)** matches words only. It cannot connect "drinks" to a
  `beverage_revenue` metric.
- **Ollama (Local)** and **OpenAI** match by meaning.

After you change it, click **Re-index catalog**.

## Where the settings are stored

Provider settings are saved in `.dql/provider-settings.json` in your project.
The starter project's `.gitignore` keeps it out of git. Keys are never sent
back to the browser.

## In Ask

The model is shown, not chosen, in Ask: open **Answer settings** (the sliders
icon under the question box) to see **Model** and pick how much **Thinking**
to use (**Auto**, **Low**, **Medium** or **High**).
