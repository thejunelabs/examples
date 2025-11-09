# Next.js Basic Web Application

This project is a foundational web application built using Next.js. It serves as a basic setup for new web projects, demonstrating core Next.js features.

## Setup

1.  **Navigate to the project directory**:
    ```bash
    cd web/nextjs-basic
    ```

2.  **Install dependencies**:
    This project uses `pnpm` for package management. If you don't have `pnpm` installed, you can install it via npm:
    ```bash
    npm install -g pnpm
    ```
    Then, install the project dependencies:
    ```bash
    pnpm install
    ```

3.  **Environment Variables**:
    If your application requires environment variables, copy the `.env.example` file to `.env` and update the values accordingly:
    ```bash
    cp .env.example .env
    ```

## Available Scripts

In the project directory, you can run:

### `pnpm dev`

Runs the application in development mode. Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload if you make edits. You will also see any lint errors in the console.

### `pnpm build`

Builds the application for production to the `.next` folder.

### `pnpm start`

Starts the production-built application. This should be run after `pnpm build`.

### `pnpm lint`

Runs the linter to catch and fix code style issues.