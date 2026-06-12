# Главное демо для шапки README: два вопроса на естественном языке, TUI-стиль.
# Рендер из корня репо: vhs docs/vhs/demo-main.tape
Output docs/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 600
Set Padding 12
Set TypingSpeed 55ms

Hide
Type "cd docs/vhs && clear && node tui.mjs scenario-main.json"
Enter
Show

Sleep 1.2s
Type "покажи мой портфель — что просело, что выросло?"
Sleep 700ms
Enter
Sleep 4.5s
Type "какие купоны и дивиденды придут в ближайшие 3 месяца?"
Sleep 700ms
Enter
Sleep 5.5s
