# Installing Kamapathy

Read this only when a command fails with `not_connected` and the reason `not_installed`, or when the person asks you to install Kamapathy. Installing software is the person's decision, so nothing here starts without their answer. `<skill>` below is this skill's folder.

## Steps

1. **Ask first.** Tell the person what the script does: it takes the newest Kamapathy release from GitHub Releases (`https://github.com/shayanmohd/kamapathy/releases`), checks the download against that release's `SHA256SUMS.txt`, and installs it for their account, without sudo on macOS. Say that builds are not signed yet, so macOS and Windows warn about an unidentified developer. Wait for their answer and stop if they say no. Never install Kamapathy with another command, and never take the app from another address.
2. **Run the script** for their computer:
   - macOS and Linux: `sh <skill>/scripts/install.sh`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File <skill>\scripts\install.ps1`

   Progress goes to stderr as `Kamapathy install: ...`, and the last line of output is `installed <path>`, `already installed <path>` or `downloaded <path>`. Options: `--dir <folder>` installs into that folder, `--no-open` leaves Kamapathy closed, and `--deb` takes the Debian package instead of the AppImage on Linux. On Windows, `-NoRun` verifies the installer without running it, for a person who wants to open it themselves.

3. **Ask the person to finish and wait for them.** The Windows installer asks where to install, and Kamapathy's first start shows welcome steps only the person can answer, including Set up agents, which gives the agents on that computer this skill and the `kamapathy` command. Ask them to work through those steps and to say when Kamapathy is open. Do not retry commands while you wait.
4. **Check the connection.** Run `node <skill>/scripts/kamapathy.mjs health`. It prints `ok Kamapathy <version>` when Kamapathy is running and agent access is on. Anything else is a `not_connected` error whose reason is explained in [connection.md](connection.md).
5. **Resume the task** you were working on, and use the `kamapathy` command if setup put it on PATH.

## Exit status

- **0**: done. The last line says whether Kamapathy was installed, was already installed, or was only downloaded.
- **1**: a download, checksum, verification, FUSE or copy failure. The last stderr line says which.
- **2**: an option the script does not know. Check the spelling against the options above.
- **3**: this computer cannot run Kamapathy: macOS is older than the build needs, or a Linux computer is not x86_64. Tell the person the version the message names and stop.

## Troubleshooting

- **A checksum mismatch.** The script deletes the file and exits 1. Stop, tell the person exactly what the script reported, and do not run it again or install from anywhere else. A download that does not match the release is a reason to report, never to retry.
- **macOS refuses to open the app.** Unsigned builds make Gatekeeper ask. The person can Control-click Kamapathy in Finder and choose Open, or allow it under System Settings, Privacy and Security. Only they can answer that, and the script never adds or removes quarantine attributes. Do not work around Gatekeeper.
- **Windows shows "Windows protected your PC".** SmartScreen warns about unsigned installers. Ask the person to choose More info and then Run anyway, or to cancel. Never pass silent-install options.
- **The AppImage needs FUSE 2.** The script exits 1 before downloading anything and names the package. Ask the person to install it, for example with `sudo apt-get install -y libfuse2`, or run the script again with `--deb`.
- **The Debian package needs sudo.** Away from a terminal the script saves the package, verifies it, and prints the `sudo apt-get install -y <path>` command for the person to run. Pass that line on and wait for them.
- **Agent access is off.** `health` then reports `not_connected` with the reason `access_off`. Ask the person to turn agent access on in Kamapathy's Settings, under Agents. Never try to work around it.
- **The `kamapathy` command is missing.** It arrives with Set up agents in the app, not with this script. Use `node <skill>/scripts/kamapathy.mjs` until the person has run it, and open a new terminal window afterwards.
