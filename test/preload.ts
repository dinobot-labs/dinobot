process.env.COLORTERM ??= "truecolor";
process.env.TERM ??= "xterm-256color";
// Golden rows use the font-independent icon set; icon tests opt into `nerd` explicitly.
process.env.DINOBOT_ICONS = "unicode";
// Problem-report diagnostics never probe external hosts from unit tests (src/report/diagnostics.ts network section).
process.env.DINOBOT_REPORT_NETWORK ??= "off";
