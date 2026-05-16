// Add escape function near the top after imports
const escapeMarkdown = (text) => {
    if (!text) return '';
    return String(text)
        .replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

console.log('✅ Escape function added');
