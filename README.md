# Historic Yiddish Press Review

This repository now includes a Streamlit OCR review app for the Pruzaner Sztyme edition bundle.


## Included defaults

- `data/default_bundle.json`: bundled edition JSON (auto-loaded on startup)
- `19381216_01.pdf`: default PDF in repository root (auto-used for page rendering)

You can still upload a different JSON and/or PDF at runtime.

## Run the Streamlit app

1. Create and activate a Python environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start the app:

```bash
streamlit run app.py
```

## What the app does

- Loads edition bundle data and page images
- Lists OCR blocks with search and review status
- Draws block bounding boxes on rendered PDF pages
- Lets reviewers edit transcription text, add comments, and set status
- Exports corrected output as JSON with a `corrections` array
