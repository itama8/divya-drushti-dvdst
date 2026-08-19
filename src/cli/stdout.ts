/**
 * Prevents an EPIPE from crashing a CLI when the consumer closes the pipe
 * early, for example `dvdst records … | head`. That is normal shell behavior;
 * the process should exit cleanly instead of printing an unhandled error.
 */
export function guardStdout(): void {
  process.stdout.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
    throw error;
  });
}