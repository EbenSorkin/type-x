import { getFonts } from "./font";

/** @type {string[]} */
let stylesheets = [];
/** @type {Object.<number, string>} */
let injectedCSS = {};
/**
 * @param {number} tabId
 * @param {string} category
 * @param {string} text
 */
async function insertOrReplaceCss(tabId, category, text) {
	const previousCss = injectedCSS[tabId]?.[category];
	if (previousCss == text) {
		return;
	}

	// Insert new CSS...
	await chrome.scripting.insertCSS({
		target: { tabId },
		css: text
	});

	if (previousCss) {
		// ...and remove old CSS *afterwards* to prevent FOUT
		await chrome.scripting.removeCSS({
			target: { tabId },
			css: previousCss
		});
	}

	if (!(tabId in injectedCSS)) {
		injectedCSS[tabId] = {};
	}

	injectedCSS[tabId][category] = text;
}

// Do the thing! (Generate stylesheet and inject into active tab)
export async function runTypeX() {
	let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
	const activeTab = tabs[0];
	if (activeTab) {
		let fontDeclarations = await generateFontStyleSheets();
		let fontFileDeclarations = await generateFontFileStyleSheets();
		await injectStyleSheets(
			activeTab.id,
			fontDeclarations,
			fontFileDeclarations
		);
	}
}

// Injecting the stylesheet is fast, adding a class to
// the body isn't. We don't want a delay, so the CSS will
// enable the fonts immediately, and we only add a class
// when we want to *remove* the custom fonts.
let customFontsOn = () => {
	delete document.documentElement.dataset.disablefont;
};
let customFontsOff = () => {
	document.documentElement.dataset.disablefont = "";
};

/**
 * @param {number} tabId
 */
async function injectStyleSheets(
	tabId,
	fontDeclarations,
	fontFileDeclarations
) {
	try {
		let { extensionActive } = await chrome.storage.local.get(
			"extensionActive"
		);
		let fontDeclarationsCss = fontDeclarations.join("\n");
		let fontFileDeclarationsCss = fontFileDeclarations.join("\n");
		if (extensionActive) {
			// Inject CSS to activate font
			await insertOrReplaceCss(tabId, "fonts", fontDeclarationsCss);
			await insertOrReplaceCss(
				tabId,
				"fontfiles",
				fontFileDeclarationsCss
			);
		}
		await chrome.scripting.executeScript({
			target: { tabId },
			func: extensionActive ? customFontsOn : customFontsOff
		});
	} catch (error) {
		// Silently ignore errors for protected pages (chrome://, extension pages, etc.)
		console.debug(`Can't inject into ${tabId}:`, error.message);
	}
}

async function generateFontStyleSheets() {
	let { blacklist } = await chrome.storage.local.get(["blacklist"]);
	let fonts = await getFonts();
	stylesheets = [];

	// Only emit one CSS rule per font/group — grouped members share the
	// parent's selectors and use the shared family name for the font stack.
	for (const font of fonts) {
		// Skip grouped members — their parent's rule already covers them
		if (font.groupId) continue;

		// If this font has grouped members, use a shared family name so the
		// browser can pick the right weight/style automatically across the group.
		// The shared name is based on the parent font's name.
		let fontName = font.name;
		let stylesheet = "";
		let selectors = font.cssSelectorString(blacklist);
		const stack = `'${fontName}', ${font.fallback}`;
		stylesheet += `
                        ${selectors} {
                            font-family: ${stack} !important;
                            ${font.cssVariationSettings()}
                            ${font.css}
                        }`;

		stylesheets.push(stylesheet);
	}
	return stylesheets;
}

async function generateFontFileStyleSheets() {
	let fonts = await getFonts();
	let { files } = await chrome.storage.local.get("files");
	let stylesheets = [];

	for (const font of fonts) {
		if (!(font.file in files)) continue;

		// Grouped members share the parent font's family name so the browser
		// treats them as one family and auto-selects weight/style correctly.
		// Top-level fonts use their own name as usual.
		const familyName = font.groupId
			? fonts.find(f => f.id === font.groupId)?.name ?? font.name
			: font.name;

		// Try to detect font-weight and font-style from the filename so the
		// browser can match them to CSS font-weight/style requests automatically.
		const fileName = font.file.toLowerCase();
		let fontWeight = "100 900"; // default: full variable range
		let fontStyle = "normal";

		// Weight hints from filename
		if (/thin|hairline/.test(fileName))         fontWeight = "100";
		else if (/extralight|ultralight/.test(fileName)) fontWeight = "200";
		else if (/light/.test(fileName))            fontWeight = "300";
		else if (/semibold|demibold/.test(fileName)) fontWeight = "600";
		else if (/extrabold|ultrabold/.test(fileName)) fontWeight = "800";
		else if (/black|heavy/.test(fileName))      fontWeight = "900";
		else if (/bold/.test(fileName))             fontWeight = "700";
		else if (/medium/.test(fileName))           fontWeight = "500";
		else if (/regular|roman/.test(fileName))    fontWeight = "400";

		// Style hints from filename
		if (/italic|oblique/.test(fileName)) fontStyle = "italic";

		stylesheets.push(`
                            @font-face {
                                font-family: '${familyName}';
                                src: url('${files[font.file].file}');
                                font-weight: ${fontWeight};
                                font-style: ${fontStyle};
                                font-stretch: 50% 200%;
                            }`);
	}
	return stylesheets;
}

// Listen for call from popup or page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.pageLoad) {
		// We moved to a new page; although we may have injected CSS into this *tab* previously,
		// we haven't for this page, so clear it from our cache so we inject some more.
		delete injectedCSS[sender.tab.id];
	}
	if (message.runTypeX) {
		runTypeX();
	}
});
