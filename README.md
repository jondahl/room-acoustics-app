# Room Acoustics Analyzer

A tool for analyzing room modes, speaker placement, and listening position acoustics.

## Local Development

```bash
npm install
npm run dev
```

## Deploy to Vercel

### Option 1: Via GitHub (Recommended)

1. Push this folder to a GitHub repository
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click "Add New Project"
4. Import your GitHub repository
5. Vercel auto-detects Vite — just click "Deploy"

### Option 2: Via Vercel CLI

```bash
# Install Vercel CLI globally
npm install -g vercel

# From the project directory, run:
vercel

# Follow the prompts. For production:
vercel --prod
```

### Option 3: Manual Upload

1. Build the project locally:
   ```bash
   npm install
   npm run build
   ```
2. Go to [vercel.com](https://vercel.com)
3. Drag and drop the `dist` folder

## Features

- Room mode calculation (axial, tangential, oblique)
- Listening position modal analysis
- Speaker SBIR and boundary gain analysis
- Support for dipole and monopole speakers
- Coupled room / open wall modeling
- Export configuration as JSON or permalink
- Generate LLM analysis prompt

## Permalink Support

The app supports loading configuration from URL parameters. Use "Copy Permalink" to share specific room configurations.
