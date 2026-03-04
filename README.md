# Dev Notes

A personal blog by Mohith — technical learnings, side projects, and things worth writing about.

This site is a writing-first static blog built with **Astro**, designed to be minimal, clean, and durable. It serves as a personal knowledge base for backend systems, system design, web development, and anything else that catches my attention.

## Tech Stack

- **Framework**: [Astro 5](https://astro.build)
- **Styling**: Plain CSS (No Tailwind, No Frameworks)
- **Deployment**: Cloudflare Pages / Static

## Features

- **Minimal Design**: No distractions.
- **Dark/Light Mode**: Respects system preference.
- **Tag System**: Dynamic tagging and filtering.
- **Performance**: Zero-JS core (JS used only for theme toggle).

## Project Structure

```bash
src/
├── components/   # UI: Header, Footer, PostCard, ThemeToggle
├── content/      # Markdown/MDX posts
├── layouts/      # BaseLayout, PostLayout
├── pages/        # Astro Routes (index, posts/[slug], tags/[tag])
└── styles/       # CSS tokens, base reset, prose styles
```

## Running Locally

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start Dev Server**:
   ```bash
   npm run dev
   ```

3. **Build for Production**:
   ```bash
   npm run build
   ```

## Design Philosophy

- **No Animations**: Prioritize speed and calmness.
- **No Marketing**: This is an engineering notebook, not a portfolio.
- **Mental Models**: Diagrams and text over flashy interactions.
