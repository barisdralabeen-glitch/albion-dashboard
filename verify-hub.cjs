const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
for (const id of ['game-hub', 'knight-view', 'dashboard-shell', 'knight-search', 'knight-search-btn']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing #${id}`);
}
for (const file of ['assets/albion-official.jpeg', 'assets/knight-official.jpg']) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}
console.log('Game hub markup and artwork assets verified.');
