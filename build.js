const fs = require('fs');
const path = require('path');

const output = path.join(__dirname, 'public');
fs.mkdirSync(output, { recursive: true });

for (const file of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(output, file));
}

console.log('TSN Academy static build ready: public/');
