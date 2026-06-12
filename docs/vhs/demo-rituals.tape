# Демо slash-команд: попап автодополнения + квартальный ритуал, TUI-стиль.
# Рендер из корня репо: vhs docs/vhs/demo-rituals.tape
Output docs/demo-rituals.gif

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 640
Set Padding 12
Set TypingSpeed 60ms

Hide
Type "cd docs/vhs && clear && node tui.mjs scenario-rituals.json"
Enter
Show

Sleep 1s
Type "/t-in"
Sleep 1.8s
Type "vest:quarterly"
Sleep 1s
Enter
Sleep 6.5s
