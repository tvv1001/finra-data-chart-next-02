# Git pull/push cheat sheet

## normal day-to-day flow

```bash
git status
git pull --rebase origin main
git push origin main
```

## if you have local edits

```bash
git status
git add .
git commit -m "your message"
git pull --rebase origin main
git push origin main
```

## if a rebase conflict happens

```bash
git status
# fix the conflicted file(s)
git add <file>
git rebase --continue
```

## if push is rejected because remote moved

```bash
git fetch origin
git pull --rebase origin main
git push origin main
```

## if you want to safely back out

```bash
git rebase --abort
```

## repo-specific tip

This repo sometimes conflicts on generated or ignore files like `.gitignore`, so it’s best to:

- pull with rebase
- resolve conflicts immediately
- avoid force-pushing unless you really mean it
