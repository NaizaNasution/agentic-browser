# Installing Agentic Browser and `agb`

The skill needs two things: the **Agentic Browser** app running, and the **`agb`** command on
your `PATH`. If `agb` is not found, tell the user and show them the steps below. Don't try to
download or install software yourself unless the user asks you to.

## Check

    agb version      # prints the CLI version, and the app version if the browser is running
    agb doctor       # checks everything: PATH, browser, skill files, versions

## Install (user steps)

Installers are not published yet; this is a development build.

1. Build from the repository: `npm ci && npm run build`. This writes `bin/agb` (`bin\agb.exe`
   on Windows).
2. Put `agb` on your `PATH`:
   - **Windows (PowerShell):**
     `[Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));<repo>\bin", "User")`,
     then open a new terminal.
   - **macOS / Linux:** `ln -s <repo>/bin/agb ~/.local/bin/agb` (make sure `~/.local/bin` is on
     your `PATH`).
3. Start the browser: `npm start` in the repository.
4. Install the skill for your agents: `agb skill install` (or `agb skill install --project`
   to put it in the current repository only).
5. Run `agb doctor`. Every line should start with `ok`.

## The browser is not running (exit code 3)

`agb` finds the browser through a small discovery file the app writes when it starts. Ask the
user to start Agentic Browser, then run the command again.
