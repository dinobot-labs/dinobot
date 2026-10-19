process.env.COLORTERM ??= "truecolor";
process.env.TERM ??= "xterm-256color";
// Golden rows use the font-independent icon set; icon tests opt into `nerd` explicitly.
process.env.DINOBOT_ICONS = "unicode";
