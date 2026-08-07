# Blog

## Generation Instructions

1. Source your virtual environment:
   ```bash
   source .venv/bin/activate
   ```

2. Run the post generation script to convert markdown to HTML:
   ```bash
   python build_posts.py
   ```

   This script will:
   - Read all `.md` files in `blog/posts_src/`
   - Extract metadata from the YAML front matter (e.g. title, date, tags, slug)
   - Convert the markdown body to HTML
   - Inject metadata and content into an HTML template
   - Output each post as an `.html` file in `blog/posts/`

3. Regenerate the `posts.json` index:
   ```bash
   python generate_posts_json.py
   ```

4. (Optional) Preview locally before committing:

   Run `bun run dev` from the repo root and open
   http://localhost:8000/blog/. It reloads on change, so re-running the two
   build steps above is enough to see the new post — no restart needed.

   (`python3 -m http.server` also still works, just without the reload.)

5. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Generate blog posts and metadata"
   git push
   ```