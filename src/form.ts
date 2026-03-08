import {
	Axis,
	Font,
	FontFile,
	IFont,
	inputFont,
	dropFont,
	getFonts,
	getFiles,
	getFamilyMembers,
	randomId
} from "./font";
import { callTypeX, showReloadAnimation, activateExtension } from "./popup";
import { defaultFonts } from "./recursive-fonts.js";

const localFonts: Record<string, FontFile> = {};

// Add local fonts and show them in the popup
chrome.fontSettings.getFontList(fonts => {
	for (const font of fonts) {
		localFonts[font.displayName] = new FontFile(
			font.displayName,
			font.displayName,
			{}, // We can't get axes/instance info from local fonts
			{}
		);
	}
	buildForm();
});

// Generate form based on current settings
export async function buildForm() {
	let { files, blacklist } = await chrome.storage.local.get([
		"files",
		"blacklist"
	]);

	const form = document.querySelector("#fontsForm");
	const usedFonts = form.querySelector("#usedFonts");

	// Clear out previous form
	while (usedFonts.firstChild) {
		usedFonts.removeChild(usedFonts.firstChild);
	}

	const allFonts = await getFonts();
	// Separate top-level fonts from grouped members
	const topLevelFonts = allFonts.filter(f => !f.groupId);
	const memberFonts = allFonts.filter(f => !!f.groupId);

	// Inject top-level fonts
	for (const font of topLevelFonts) {
		await addFormElement(font, files);
	}

	// Now attach grouped members to their parent fieldsets
	for (const member of memberFonts) {
		const parentFieldset = usedFonts.querySelector<HTMLFieldSetElement>(
			`fieldset[data-fontid="${member.groupId}"]`
		);
		if (parentFieldset) {
			await addGroupedMemberElement(member, files, parentFieldset);
		}
	}

	// Inject blacklist
	const blacklistEl = form.querySelector(
		"[name=blacklist]"
	) as HTMLInputElement;
	blacklistEl.value = blacklist.join(", ");
	blacklistEl.oninput = async () => {
		blacklist = blacklistEl.value.split(",").map(item => item.trim());
		await chrome.storage.local.set({ blacklist });
		callTypeX();
	};
}

// Add new font to the form
export async function addFormElement(
	font: Font,
	files: Record<string, FontFile>
) {
	const usedFonts = document.querySelector("#usedFonts");
	const template: HTMLTemplateElement = document.querySelector("#newFont");
	const el = document.importNode(template.content, true);
	const parentEl: HTMLFieldSetElement = el.querySelector(".font");

	const fontSelect = el.querySelector(".font-file-select");

	const dropdown = document.createElement("select") as HTMLSelectElement;
	dropdown.setAttribute("name", "file");
	dropdown.setAttribute("id", `file${font.id}`);
	dropdown.classList.add("font-file-select");
	dropdown.onchange = async () => {
		let newFontFileName = dropdown.options[dropdown.selectedIndex].value;
		await changeFont(parentEl, newFontFileName);
	};

	const extensionGroup = document.createElement("optgroup");
	extensionGroup.setAttribute("label", "Custom fonts:");
	for (const fileName in files) {
		const option = document.createElement("option");
		option.value = fileName;
		option.text = files[fileName].name;
		option.selected = font.file == fileName;
		extensionGroup.append(option);
	}
	dropdown.append(extensionGroup);

	const localGroup = document.createElement("optgroup");
	localGroup.setAttribute("label", "Local fonts:");
	for (const fileName in localFonts) {
		const option = document.createElement("option");
		option.value = fileName;
		option.text = fileName;
		// Local fonts don't have filenames, so check name instead
		option.selected = font.name == fileName;
		localGroup.append(option);
	}
	dropdown.append(localGroup);

	fontSelect.replaceWith(dropdown);

	const newFileInput: HTMLInputElement = el.querySelector("[name=newfile]");
	newFileInput.dataset.fontid = font.id;
	newFileInput.onchange = async e => {
		await inputFont(e, async fontFileName => {
			// Font has been added to the files[] array, need a new font element
			// for it.
			await changeFont(parentEl, fontFileName);
			// Rebuild dropdowns
			await buildForm();
			// Auto-enable extension
			await autoEnableExtension();
		});
	};
	el.querySelector<HTMLButtonElement>(".show-fallbacks").onclick = e => {
		(e.target as HTMLButtonElement)
			.closest("fieldset")
			.classList.toggle("show-font-fallbacks");
	};

	el.querySelector<HTMLButtonElement>(".delete-font").onclick = async e => {
		let fontId = (e.target as HTMLButtonElement).closest("fieldset").dataset
			.fontid;
		let fonts = await getFonts();
		if (!fonts.find(f => f.id == fontId)) {
			console.error("Couldn't find font with ID", fontId);
			return;
		}
		fonts = fonts.filter(f => f.id != fontId);
		await chrome.storage.local.set({ fonts });
		// Remove element from form
		(e.target as HTMLButtonElement).closest("fieldset").remove();
	};

	el.querySelector<HTMLButtonElement>(".font-title button").onclick = e => {
		(e.target as HTMLButtonElement)
			.closest("fieldset")
			.classList.toggle("show-font-details");
	};

	if (font.new) {
		el.querySelector("fieldset").classList.add("show-font-details");
	}

	// --- Family members feature ---
	// After rendering, check for fonts sharing the same Preferred Family
	// and show a button to add them as grouped sub-entries
	(async () => {
		if (!font.file) return; // local font, skip
		const members = await getFamilyMembers(font.file);
		const memberEntries = Object.entries(members);
		if (memberEntries.length === 0) return;

		// Only show if no members are already grouped under this font
		const existingFonts = await getFonts();
		const alreadyGrouped = existingFonts
			.filter(f => f.groupId === font.id)
			.map(f => f.file);
		const ungrouped = memberEntries.filter(
			([fileName]) => !alreadyGrouped.includes(fileName)
		);
		if (ungrouped.length === 0) return;

		const files = await getFiles();
		const familyName = files[font.file]?.preferredFamily || "this family";

		// Create the "Add family members" button
		const familyBtn = document.createElement("button");
		familyBtn.type = "button";
		familyBtn.className = "add-family-members-btn";
		familyBtn.title = `Other fonts from "${familyName}" were found`;
		familyBtn.textContent = `👨‍👩‍👧 Add family members (${ungrouped.length} found)`;

		// Build panel from template
		const panelTemplate = document.querySelector<HTMLTemplateElement>("#familyMembersPanel");
		const panelEl = document.importNode(panelTemplate.content, true);
		const panel = panelEl.querySelector<HTMLDivElement>(".family-members-panel");
		panel.querySelector(".family-count").textContent = String(ungrouped.length);
		panel.querySelector(".family-count-plural").textContent = ungrouped.length > 1 ? "s" : "";
		panel.querySelector(".family-name").textContent = familyName;

		const checkboxContainer = panel.querySelector(".family-checkboxes");
		for (const [fileName, fontFile] of ungrouped) {
			const label = document.createElement("label");
			label.className = "family-member-checkbox";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.value = fileName;
			cb.checked = true;
			label.append(cb, document.createTextNode(` ${fontFile.name}`));
			checkboxContainer.append(label);
		}

		familyBtn.onclick = () => {
			const isOpen = panel.style.display !== "none";
			panel.style.display = isOpen ? "none" : "block";
		};

		panel.querySelector(".family-cancel-btn").addEventListener("click", () => {
			panel.style.display = "none";
		});

		panel.querySelector(".family-confirm-btn").addEventListener("click", async () => {
			const checked = Array.from(
				panel.querySelectorAll<HTMLInputElement>(".family-member-checkbox input:checked")
			).map(cb => cb.value);

			if (checked.length === 0) {
				panel.style.display = "none";
				return;
			}

			let fonts = await getFonts();
			let files = await getFiles();

			for (const memberFileName of checked) {
				const memberFile = files[memberFileName];
				if (!memberFile) continue;
				const memberFont = Font.fromObject({
					name: memberFile.name,
					new: false,
					id: randomId(),
					file: memberFileName,
					location: memberFile.defaultLocation || {},
					inherit: font.inherit,
					fallback: font.fallback,
					selectors: [...font.selectors], // Share parent's selectors
					css: font.css,
					groupId: font.id // Link to parent font
				});
				fonts.push(memberFont);
				// Add visually into the group container
				await addGroupedMemberElement(memberFont, files, parentEl);
			}

			await chrome.storage.local.set({ fonts });

			// Remove button and panel now that members are added
			familyBtn.remove();
			panel.remove();
		});

		// Insert button + panel into the font header area
		const fontTitle = parentEl.querySelector(".font-title");
		fontTitle.after(familyBtn, panel);
	})();
	// --- End family members feature ---

	await addVariableSliders(font, parentEl);
	await addNamedInstances(font, parentEl);

	// Set up font name and instance in title
	await setFontNameAndInstance(font, parentEl);

	parentEl.addEventListener("dragover", highlight, false);
	parentEl.addEventListener("dragleave", unhighlight, false);
	parentEl.addEventListener(
		"drop",
		async e => {
			await dropFont(
				e,
				async fontFileName => {
					// Font has been added to the files[] array, need a new font element
					// for it.
					await changeFont(parentEl, fontFileName);
					// Rebuild dropdowns
					await buildForm();
					// Auto-enable extension
					await autoEnableExtension();
				},
				async () => {
					// Ask tabs to show reloading animation
					showReloadAnimation();
					callTypeX();
				}
			);
			unhighlight.bind(parentEl)(e);
		},
		false
	);

	const textareas = el.querySelectorAll("textarea");
	textareas.forEach(textarea => {
		textarea.oninput = async e => {
			const target = e.target as HTMLTextAreaElement;
			const parent = target.closest("fieldset") as HTMLFieldSetElement;
			let font = await getFont(parent.dataset.fontid);
			if (!font) return;
			if (target.name === "selectors") {
				font.selectors = target.value.split(",").map(i => i.trim());
			} else if (target.name === "css") {
				font.css = target.value;
			} else if (target.name === "fallback") {
				font.fallback = target.value;
			}
			await updateFont(font);
		};
	});

	// Auto-enable extension when interacting with font controls
	const fontDetails = el.querySelector(".font-details");
	if (fontDetails) {
		const formElements = fontDetails.querySelectorAll(
			"input, select, textarea"
		);
		formElements.forEach(element => {
			element.addEventListener("change", autoEnableExtension);
		});
	}

	usedFonts.prepend(el);
}

async function autoEnableExtension() {
	let { extensionActive } = await chrome.storage.local.get("extensionActive");
	if (!extensionActive) {
		await activateExtension(true);
	}
}

async function changeFont(
	parent: HTMLFieldSetElement,
	newFontFileName: string
) {
	const fontId = parent.dataset.fontid;
	let fonts = await getFonts();
	let files = await getFiles();
	// Check if newfont is in files or localFonts
	let existing = fonts.find(f => f.id == fontId);
	if (!existing) {
		console.error(
			"Couldn't find font with ID",
			fontId,
			" when changing to ",
			newFontFileName
		);
		return;
	}
	if (newFontFileName in files) {
		// It's a custom font
		existing.file = newFontFileName;
		existing.name = files[newFontFileName].name;
	} else if (newFontFileName in localFonts) {
		// It's a local font
		existing.file = "";
		existing.name = newFontFileName;
	}
	existing.location = files[existing.file]?.defaultLocation || {};
	existing.new = true;
	await chrome.storage.local.set({ fonts }); // Updating storage also calls typeX
	await addVariableSliders(existing, parent);
	await addNamedInstances(existing, parent);
	await setFontNameAndInstance(existing, parent);
}

async function setFontNameAndInstance(font: Font, el: HTMLFieldSetElement) {
	el.dataset.fontid = font.id;
	el.querySelector<HTMLSpanElement>(".font-name-title").innerText =
		font.name || "New font override";
	el.querySelector<HTMLInputElement>("[name=id]").value = font.id;
	el.querySelector<HTMLTextAreaElement>("[name=css]").value = font.css;
	el.querySelector<HTMLTextAreaElement>("[name=fallback]").value =
		font.fallback;
	el.querySelector<HTMLTextAreaElement>("[name=selectors]").value =
		font.selectors.join(", ");

	const instanceDropdown: HTMLSelectElement | null =
		el.querySelector(".select-instance");
	const fontNameInstanceLabel = el.querySelector<HTMLSpanElement>(
		".font-name-instance"
	);
	let activeInstance = await font.activeInstance();
	if (instanceDropdown) {
		instanceDropdown.value = activeInstance || "--axes--";
		fontNameInstanceLabel.innerText = activeInstance || "--axes--";
	}
	if (font.inherit) {
		fontNameInstanceLabel.innerText = "[Inherit page styles]";
		if (instanceDropdown) {
			instanceDropdown.value = "--inherit--";
		}
	}
}

/**
 * Add named instances to the font editor.
 */
async function addNamedInstances(font: Font, el: HTMLElement) {
	const container = el.querySelector(".variable-instances");
	container.innerHTML = "";

	// Create instances dropdown
	const dropdown = document.createElement("select");
	dropdown.classList.add("select-instance");
	dropdown.name = "select-instance";
	dropdown.onchange = applyNamedInstance;

	// Add "turn off font-variation-settings" option
	const option = document.createElement("option");
	option.text = "[Inherit page styles]";
	option.value = "--inherit--";
	dropdown.append(option);

	// Add "using axes, but none of a named instance" option
	const option2 = document.createElement("option");
	option2.text = "[Custom axes]";
	option2.value = "--axes--";
	option2.disabled = true;
	dropdown.append(option2);

	let fontfile = await font.fontFile();

	let instances = fontfile ? fontfile.instances : {};
	if (Object.keys(instances).length > 0) {
		for (const instance in instances) {
			const option = document.createElement("option");
			option.text = instance;
			option.value = instance;
			dropdown.append(option);
		}

		container.append(dropdown);
	}
}

async function getFont(id: string): Promise<Font | null> {
	let fonts = await getFonts();
	let font = fonts.find(f => f.id == id);
	if (!font) {
		console.error("Couldn't find font with ID", id);
		return null;
	}
	await updateFont(font);
	return font;
}

function reenableMutedSliders(font: Font, container: Element) {
	(container as HTMLElement).addEventListener(
		"mousedown",
		async () => {
			if (!font.inherit) return;
			container.classList.remove("mute");
			font.inherit = false;
			await updateFont(font);
		},
		{ once: true }
	);
}

async function applyNamedInstance(e: Event) {
	const sel = e.target as HTMLSelectElement;
	const parent = sel.closest(".font") as HTMLFieldSetElement;
	let font = await getFont(parent.dataset.fontid);
	if (!font) return;
	const instanceName = sel.value == "--inherit--" ? "" : sel.value;
	parent.querySelector<HTMLSpanElement>(".font-name-instance").innerText =
		instanceName;

	let sliders = parent.querySelector(".variable-sliders-container");

	font.inherit = sel.value == "--inherit--";

	if (font.inherit) {
		sliders.classList.add("mute");
		reenableMutedSliders(font, sliders);
		await updateFont(font);
		return;
	}
	sliders.classList.remove("mute");
	await font.setInstance(instanceName);
	// Move sliders to the correct positions
	sliders.querySelectorAll(".variable-slider").forEach(slider => {
		let input = slider.querySelector("input");
		let span = slider.querySelector(".slider-value");
		let axisId = input.name.replace("var-", "");
		if (axisId in font.location) {
			input.value = font.location[axisId].toString();
			span.innerHTML = input.value;
		}
	});
	// Save font object in storage, which in turn updates the tabs
	await updateFont(font);
}

async function addVariableSliders(font: Font, el: HTMLElement) {
	el.querySelector(".variable-sliders").innerHTML = "";
	let container = el.querySelector(".variable-sliders-container");
	let axes = (await font.fontFile())?.axes;
	if (!axes) {
		container.classList.remove("show");
	} else {
		for (let axis of Object.values(axes)) {
			addSlider(font, axis, el);
		}
		container.classList.add("show");
	}
	// If we start with inherit, we start muted
	if (font.inherit) {
		container.classList.add("mute");
		// If a user clicks muted sliders, assume they want to
		// go into custom axes mode
		reenableMutedSliders(font, container);
	}
}

function addSlider(font: Font, axis: Axis, parent: HTMLElement) {
	const variableSliders = parent.querySelector(".variable-sliders");
	const template: HTMLTemplateElement =
		document.querySelector("#variableSlider");
	const el = document.importNode(template.content, true);

	const input: HTMLInputElement = el.querySelector("input");
	const label: HTMLLabelElement = el.querySelector("label");
	const value: HTMLSpanElement = el.querySelector(".slider-value");

	label.innerText = axis.name;

	input.name = `var-${axis.id}`;
	input.min = axis.min.toString();
	input.max = axis.max.toString();
	if (axis.id in font.location) {
		input.value = font.location[axis.id].toString();
		value.innerText = font.location[axis.id].toString();
	} else {
		// Use default from font file
		input.value = axis.default.toString();
		value.innerText = axis.default.toString();
		font.location[axis.id] = axis.default;
	}

	input.onchange = async e => {
		let fontId = parent.dataset.fontid;
		let font = await getFont(fontId);
		let newValue = (e.target as HTMLInputElement).value;
		value.innerText = newValue;
		// Store the value back in the font object
		font.location[axis.id] = parseFloat(newValue);
		/// If we're on an instance, update .select-instance
		const dropdown =
			parent.querySelector<HTMLSelectElement>(".select-instance");
		if (dropdown) {
			dropdown.value = (await font.activeInstance()) || "--axes--";
		}
		await updateFont(font);
	};

	variableSliders.append(el);
}

function highlight(e: Event) {
	this.classList.add("highlight");
	e.preventDefault();
	e.stopPropagation();
}

function unhighlight(e: Event) {
	this.classList.remove("highlight");
	e.preventDefault();
	e.stopPropagation();
}

async function setStorageKeyIfNotFound(key: string, defaultValue: Font[]) {
	try {
		const result = await chrome.storage.local.get(key);
		if (result[key] === undefined) {
			// Value not found, set it
			await chrome.storage.local.set({ [key]: defaultValue });
			console.log(`${key} set to:`, defaultValue);
		} else {
			// Value already exists
			console.log(`${key} already exists with value:`, result[key]);
		}
	} catch (error) {
		console.error("Error accessing chrome.storage.local:", error);
	}
}

async function updateFont(font: Font) {
	setStorageKeyIfNotFound("fonts", defaultFonts);
	let { fonts } = await chrome.storage.local.get("fonts");
	let fontId = font.id;
	fonts = fonts.map((f: Font) => (f.id === fontId ? font : f));
	await chrome.storage.local.set({ fonts }); // Updating storage calls typeX
}

/**
 * Renders a family member font as a compact sub-entry grouped visually
 * under the parent font's fieldset.
 */
export async function addGroupedMemberElement(
	font: Font,
	files: Record<string, FontFile>,
	parentFieldset: HTMLFieldSetElement
) {
	// Find or create the grouped-members container inside the parent fieldset
	let groupContainer = parentFieldset.querySelector<HTMLDivElement>(".grouped-members");
	if (!groupContainer) {
		groupContainer = document.createElement("div");
		groupContainer.className = "grouped-members";
		parentFieldset.append(groupContainer);
	}

	const memberEl = document.createElement("div");
	memberEl.className = "grouped-member";
	memberEl.dataset.fontid = font.id;

	const fontFile = files[font.file];
	const memberName = fontFile?.name || font.name || font.file;

	memberEl.innerHTML = `
		<span class="grouped-member-name">↳ ${memberName}</span>
		<button type="button" class="remove-member-btn" title="Remove this family member">✕</button>
	`;

	memberEl.querySelector(".remove-member-btn").addEventListener("click", async () => {
		let fonts = await getFonts();
		fonts = fonts.filter(f => f.id !== font.id);
		await chrome.storage.local.set({ fonts });
		memberEl.remove();
		if (groupContainer.children.length === 0) {
			groupContainer.remove();
		}
	});

	groupContainer.append(memberEl);
}
