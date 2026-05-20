'use strict';
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'interactive_elements.json');
if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const visible = data.filter(el => el.isVisible && !el.error);

console.log(`Found ${visible.length} visible elements:`);
visible.forEach((el, index) => {
    console.log(`[${index}] Path: ${el.path} | Tag: ${el.tagName} | Text: "${el.text.replace(/\n/g, ' ')}" | Class: "${el.className}"`);
});
