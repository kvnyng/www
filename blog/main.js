console.log("main.js loaded!");

const BLOG_LIST = document.getElementById('blog-list');
const POSTS_JSON = 'posts.json';
const VIEW_API = 'https://view-counter-worker.kvnyng.workers.dev'; // Replace with your actual Worker endpoint

// Fetch and render posts
fetch(POSTS_JSON)
    .then(response => response.json())
    .then(posts => {
        posts.forEach(post => {
            const wrapper = document.createElement('div');
            wrapper.className = 'post-quote';

            const link = document.createElement('a');
            link.href = post.url;
            link.className = 'post-link';

            const title = document.createElement('span');
            title.textContent = post.title;

            const count = document.createElement('span');
            count.className = 'read-count';
            count.textContent = ''; // Will be updated later

            const date = document.createElement('span');
            date.className = 'read-count';
            date.style.marginLeft = 'auto';
            date.style.color = 'var(--grey-out)';
            date.style.fontStyle = 'italic';
            date.style.fontSize = '0.95rem';
            if (post.date) {
                const [year, month, day] = post.date.split('-');
                const formatted = new Date(year, month - 1, day).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
                date.textContent = formatted;
            } else {
                date.textContent = '';
            }

            link.appendChild(title);
            link.appendChild(count);
            link.appendChild(date);
            wrapper.appendChild(link);
            BLOG_LIST.appendChild(wrapper);

            // Fetch view count
            fetch(`${VIEW_API}?slug=${post.slug}`)
                .then(res => res.json())
                .then(data => {
                    count.textContent = `${data.views} views`;
                });
        });
    })
    .catch(error => {
        console.error('Failed to load posts:', error);
    });
