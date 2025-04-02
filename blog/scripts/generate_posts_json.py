import os
import json

POSTS_DIR = "../blog/posts"
POSTS_JSON_PATH = "../blog/posts.json"
SRC_DIR = "../blog/posts_src"

def slugify(filename):
    return os.path.splitext(filename)[0].lower().replace(' ', '-')

def generate_post_entry(filename):
    title = os.path.splitext(filename)[0].replace('-', ' ').title()
    slug = slugify(filename)
    url = f"posts/{filename}"

    # Try to extract date and subtitle from the HTML file's meta tags
    date = ""
    subtitle = ""
    filepath = os.path.join(POSTS_DIR, filename)
    with open(filepath, 'r') as f:
        for line in f:
            if 'name="date"' in line and 'content=' in line:
                start = line.find('content="') + len('content="')
                end = line.find('"', start)
                date = line[start:end]
            if 'name="subtitle"' in line and 'content=' in line:
                start = line.find('content="') + len('content="')
                end = line.find('"', start)
                subtitle = line[start:end]

    return {"title": title, "slug": slug, "url": url, "date": date, "subtitle": subtitle}

def main():
    if not os.path.exists(POSTS_JSON_PATH):
        existing = []
    else:
        with open(POSTS_JSON_PATH, "r") as f:
            existing = json.load(f)

    hidden_sources = {os.path.splitext(f)[0] for f in os.listdir(SRC_DIR) if f.startswith('!') and f.endswith('.md')}
    existing_files = set(os.listdir(POSTS_DIR))
    updated_posts = []

    for filename in existing_files:
        if filename.endswith(".html"):
            base_name = os.path.splitext(filename)[0]
            if base_name in hidden_sources:
                continue
            updated_posts.append(generate_post_entry(filename))

    # Sort posts by date descending
    updated_posts.sort(key=lambda p: p.get('date', ''), reverse=True)

    with open(POSTS_JSON_PATH, "w") as f:
        json.dump(updated_posts, f, indent=2)

    print(f"posts.json updated with {len(updated_posts)} post(s).")

if __name__ == "__main__":
    main()