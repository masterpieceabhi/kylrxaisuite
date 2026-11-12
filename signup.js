/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - CUSTOMER & CEO SIGNUP CONTROLLER
 * ============================================================================
 * 
 * Captures the full Organization Setup directly during Customer / CEO Registration:
 * 1. CEO / Super Admin Account Credentials (with 6-point password strength)
 * 2. Company & Legal Profile (Attributes 1 - 7)
 * 3. Address & Regional Settings (Attributes 8 - 16)
 * 4. Statutory & Legal Identifiers (Attributes 17 - 20, with Official_Email as 21)
 * 
 * Processing on Form Submission:
 * - Create Firebase Auth user
 * - Provision user record with Super Admin role & trigger custom claims
 * - Save 21 attributes in Firestore organizations/{orgId} with { orgConfigured: true }
 * - Initialize atomic sequential employee counter at organizations/{orgId}/counters/employees (EMP0001)
 * - Redirect CEO directly to the main Super Admin Central Dashboard (admin-central-dashboard.html)
 * 
 * @version 2.0.0
 * @author Senior Frontend & Firebase Developer
 */

import { auth, storage } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

// Stepper State
let currentStep = 1;
const totalSteps = 4;

// DOM Elements - Stepper
const stepIndicators = [
    document.getElementById('stepIndicator1'),
    document.getElementById('stepIndicator2'),
    document.getElementById('stepIndicator3'),
    document.getElementById('stepIndicator4')
];
const stepPanels = [
    document.getElementById('panelStep1'),
    document.getElementById('panelStep2'),
    document.getElementById('panelStep3'),
    document.getElementById('panelStep4')
];
const stepProgressLine = document.getElementById('stepProgressLine');

// Navigation Buttons
const btnNext1 = document.getElementById('btnNext1');
const btnNext2 = document.getElementById('btnNext2');
const btnNext3 = document.getElementById('btnNext3');
const btnBack2 = document.getElementById('btnBack2');
const btnBack3 = document.getElementById('btnBack3');
const btnBack4 = document.getElementById('btnBack4');
const signupBtn = document.getElementById('signupBtn');
const signupForm = document.getElementById('signupForm');
const errorMessage = document.getElementById('errorMessage');
const btnFillDemoSignup = document.getElementById('btnFillDemoSignup');

// Step 1: Account Elements
const nameInput = document.getElementById('name');
const emailInput = document.getElementById('email');
const emailFeedback = document.getElementById('emailFeedback');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const confirmFeedback = document.getElementById('confirmFeedback');
const termsInput = document.getElementById('terms');

// Password Strength Elements
const strengthFill = document.getElementById('strengthFill');
const strengthText = document.getElementById('strengthText');
const chkLength = document.getElementById('chkLength');
const chkUpper = document.getElementById('chkUpper');
const chkLower = document.getElementById('chkLower');
const chkNumber = document.getElementById('chkNumber');
const chkSpecial = document.getElementById('chkSpecial');

// Step 2: Company Profile Elements
const legalNameInput = document.getElementById('legalName');
const displayNameInput = document.getElementById('displayName');
const orgTypeSelect = document.getElementById('orgType');
const industryInput = document.getElementById('industry');
const websiteInput = document.getElementById('website');
const officialPhoneInput = document.getElementById('officialPhone');
const logoUrlInput = document.getElementById('logoUrl');
const logoFileInput = document.getElementById('logoFileInput');
const logoUploadStatus = document.getElementById('logoUploadStatus');

// Step 3: Address Elements
const countryInput = document.getElementById('country');
const stateInput = document.getElementById('state');
const cityInput = document.getElementById('city');
const pinCodeInput = document.getElementById('pinCode');
const registeredAddressInput = document.getElementById('registeredAddress');
const corporateAddressInput = document.getElementById('corporateAddress');
const sameAddressCheck = document.getElementById('sameAddressCheck');
const timeZoneSelect = document.getElementById('timeZone');
const currencySelect = document.getElementById('currency');
const fyStartSelect = document.getElementById('fyStart');

// Step 4: Statutory Compliance Elements
const panInput = document.getElementById('pan');
const tanInput = document.getElementById('tan');
const cinInput = document.getElementById('cin');
const gstinInput = document.getElementById('gstin');

// Initialize Events on Page Load
document.addEventListener('DOMContentLoaded', () => {
    setupStepNavigation();
    setupPasswordStrength();
    setupPasswordVisibilityToggles();
    setupAddressSync();
    setupLogoUpload();
    setupDemoDataAutofill();
    setupFormSubmission();
    updateProgressUI();
});

// ============================================================================
// 1. STEPPER NAVIGATION & PROGRESS
// ============================================================================

function setupStepNavigation() {
    // Next Buttons with validation gating
    if (btnNext1) {
        btnNext1.onclick = () => {
            if (validateStep1()) goToStep(2);
        };
    }

    if (btnNext2) {
        btnNext2.onclick = () => {
            if (validateStep2()) goToStep(3);
        };
    }

    if (btnNext3) {
        btnNext3.onclick = () => {
            if (validateStep3()) goToStep(4);
        };
    }

    // Back Buttons
    if (btnBack2) btnBack2.onclick = () => goToStep(1);
    if (btnBack3) btnBack3.onclick = () => goToStep(2);
    if (btnBack4) btnBack4.onclick = () => goToStep(3);

    // Clickable Step Indicators
    stepIndicators.forEach((indicator, index) => {
        if (!indicator) return;
        indicator.onclick = () => {
            const targetStep = index + 1;
            if (targetStep < currentStep) {
                goToStep(targetStep);
            } else if (targetStep > currentStep) {
                // Verify all prior steps before leaping forward
                if (currentStep === 1 && !validateStep1()) return;
                if (currentStep === 2 && !validateStep2()) return;
                if (currentStep === 3 && !validateStep3()) return;
                goToStep(targetStep);
            }
        };
    });
}

function goToStep(step) {
    if (step < 1 || step > totalSteps) return;
    currentStep = step;
    hideError();

    // Switch active panel
    stepPanels.forEach((panel, idx) => {
        if (panel) {
            panel.classList.toggle('active', idx + 1 === currentStep);
        }
    });

    updateProgressUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateProgressUI() {
    // Calculate progress line width
    const percentage = ((currentStep - 1) / (totalSteps - 1)) * 100;
    if (stepProgressLine) {
        stepProgressLine.style.width = `${percentage}%`;
    }

    // Update indicator states
    stepIndicators.forEach((indicator, idx) => {
        if (!indicator) return;
        const stepNum = idx + 1;
        indicator.classList.remove('active', 'completed');
        if (stepNum === currentStep) {
            indicator.classList.add('active');
        } else if (stepNum < currentStep) {
            indicator.classList.add('completed');
            const circle = indicator.querySelector('.step-circle');
            if (circle) circle.innerHTML = '<i data-lucide="check" style="width: 16px; height: 16px;"></i>';
        } else {
            const circle = indicator.querySelector('.step-circle');
            if (circle) circle.textContent = String(stepNum);
        }
    });

    if (window.lucide) lucide.createIcons();
}

// ============================================================================
// 2. VALIDATION LOGIC FOR EACH STEP
// ============================================================================

function validateStep1() {
    const name = nameInput.value.trim();
    const email = emailInput.value.trim().toLowerCase();
    const pw = passwordInput.value;
    const cpw = confirmPasswordInput.value;
    const terms = termsInput.checked;

    if (!name) {
        showError("Please enter your Full Name.");
        nameInput.focus();
        return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
        showError("Please enter a valid Official Corporate Email.");
        emailInput.focus();
        return false;
    }

    const hasLength = pw.length >= 8;
    const hasUpper = /[A-Z]/.test(pw);
    const hasLower = /[a-z]/.test(pw);
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[@$!%*?&#]/.test(pw);

    if (!(hasLength && hasUpper && hasLower && hasNumber && hasSpecial)) {
        showError("Password does not meet all 5 security requirements.");
        passwordInput.focus();
        return false;
    }

    if (pw !== cpw) {
        showError("Passwords do not match. Please verify.");
        confirmPasswordInput.focus();
        return false;
    }

    if (!terms) {
        showError("You must agree to the Terms of Service & Privacy Policy to continue.");
        termsInput.focus();
        return false;
    }

    hideError();
    return true;
}

function validateStep2() {
    const legalName = legalNameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const orgType = orgTypeSelect.value;
    const industry = industryInput.value.trim();
    const phone = officialPhoneInput.value.trim();

    if (!legalName) {
        showError("Please enter the Legal Name of your organization.");
        legalNameInput.focus();
        return false;
    }

    if (!displayName) {
        showError("Please enter a Display / Brand Name.");
        displayNameInput.focus();
        return false;
    }

    if (!orgType) {
        showError("Please select the Organization Type.");
        orgTypeSelect.focus();
        return false;
    }

    if (!industry) {
        showError("Please specify the Industry sector.");
        industryInput.focus();
        return false;
    }

    if (!phone) {
        showError("Please provide an Official Phone number.");
        officialPhoneInput.focus();
        return false;
    }

    hideError();
    return true;
}

function validateStep3() {
    const country = countryInput.value.trim();
    const state = stateInput.value.trim();
    const city = cityInput.value.trim();
    const pin = pinCodeInput.value.trim();
    const regAddr = registeredAddressInput.value.trim();
    const corpAddr = corporateAddressInput.value.trim();

    if (!country) {
        showError("Please provide Country.");
        countryInput.focus();
        return false;
    }

    if (!state) {
        showError("Please enter State.");
        stateInput.focus();
        return false;
    }

    if (!city) {
        showError("Please enter City.");
        cityInput.focus();
        return false;
    }

    if (!pin) {
        showError("Please enter PIN Code / Postal Code.");
        pinCodeInput.focus();
        return false;
    }

    if (isUsSignup()) {
        if (!/^[A-Za-z]{2}$/.test(state)) { showError('Enter the 2-letter state code, for example TX.'); stateInput.focus(); return false; }
        if (!/^\d{5}(-\d{4})?$/.test(pin)) { showError('Enter a 5-digit ZIP code.'); pinCodeInput.focus(); return false; }
    }

    if (!regAddr) {
        showError("Please enter the Registered Address.");
        registeredAddressInput.focus();
        return false;
    }

    if (!corpAddr) {
        showError("Please enter Corporate Address.");
        corporateAddressInput.focus();
        return false;
    }

    hideError();
    return true;
}

const isUsSignup = () => /^(united states|usa|us)$/i.test(countryInput.value.trim());

/** Switches the address labels, regional defaults and the tax-number step between India and the United States */
function applyCountry() {
    const us = isUsSignup();
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('stateLabel', us ? '9. State (2 letters) *' : '9. State *'); set('pinLabel', us ? '11. ZIP Code *' : '11. PIN Code *');
    stateInput.placeholder = us ? 'e.g. TX' : 'e.g. Karnataka'; stateInput.maxLength = us ? 2 : 60; cityInput.placeholder = us ? 'e.g. Dallas' : 'e.g. Bengaluru'; pinCodeInput.placeholder = us ? 'e.g. 75201' : 'e.g. 560103';
    timeZoneSelect.value = us ? 'America/Chicago' : 'Asia/Kolkata'; currencySelect.value = us ? 'USD' : 'INR'; fyStartSelect.value = us ? '01-01' : '04-01';
    [panInput, tanInput, cinInput, gstinInput].forEach((el) => { const g = el.closest('.form-group'); if (g) g.style.display = us ? 'none' : ''; if (el !== cinInput) el.required = !us; if (us) el.value = ''; });
    const note = document.getElementById('usStatNote'); if (note) note.style.display = us ? 'block' : 'none';
    const desc = document.getElementById('statDescIn'); if (desc) desc.style.display = us ? 'none' : '';
}
countryInput.addEventListener('change', applyCountry);

function validateStep4() {
    if (isUsSignup()) { hideError(); return true; }
    const pan = panInput.value.trim().toUpperCase();
    const tan = tanInput.value.trim().toUpperCase();
    const gstin = gstinInput.value.trim().toUpperCase();

    if (!pan) {
        showError("Please enter 10-character PAN.");
        panInput.focus();
        return false;
    }
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
        showError(`Invalid PAN format: "${pan}". Must be 10 characters (e.g. AAACK1234F).`);
        panInput.focus();
        return false;
    }

    if (!tan) {
        showError("Please enter 10-character TAN.");
        tanInput.focus();
        return false;
    }
    if (!/^[A-Z]{4}[0-9]{5}[A-Z]{1}$/.test(tan)) {
        showError(`Invalid TAN format: "${tan}". Must be 10 characters (e.g. BLRK12345D).`);
        tanInput.focus();
        return false;
    }

    if (!gstin) {
        showError("Please enter 15-character GSTIN.");
        gstinInput.focus();
        return false;
    }
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)) {
        showError(`Invalid GSTIN format: "${gstin}". Must be 15 characters (e.g. 29AAACK1234F1Z5).`);
        gstinInput.focus();
        return false;
    }

    hideError();
    return true;
}

// ============================================================================
// 3. REAL-TIME INPUT LISTENERS & PASSWORD CHECKLIST
// ============================================================================

function setupPasswordStrength() {
    emailInput.addEventListener('input', () => {
        const val = emailInput.value.trim();
        if (!val) {
            emailFeedback.textContent = '';
            emailFeedback.className = 'validation-feedback';
            return;
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(val)) {
            emailFeedback.textContent = '✗ Invalid email format';
            emailFeedback.className = 'validation-feedback invalid';
            emailFeedback.style.color = '#ef4444';
        } else {
            emailFeedback.textContent = '✓ Valid corporate email format';
            emailFeedback.className = 'validation-feedback valid';
            emailFeedback.style.color = '#10b981';
        }
    });

    passwordInput.addEventListener('input', evaluatePasswordStrength);
    confirmPasswordInput.addEventListener('input', evaluateConfirmPassword);
}

function evaluatePasswordStrength() {
    const val = passwordInput.value;
    const hasLength = val.length >= 8;
    const hasUpper = /[A-Z]/.test(val);
    const hasLower = /[a-z]/.test(val);
    const hasNumber = /[0-9]/.test(val);
    const hasSpecial = /[@$!%*?&#]/.test(val);

    updateChecklistItem(chkLength, hasLength);
    updateChecklistItem(chkUpper, hasUpper);
    updateChecklistItem(chkLower, hasLower);
    updateChecklistItem(chkNumber, hasNumber);
    updateChecklistItem(chkSpecial, hasSpecial);

    let score = 0;
    if (hasLength) score++;
    if (hasUpper) score++;
    if (hasLower) score++;
    if (hasNumber) score++;
    if (hasSpecial) score++;

    let color = '#ef4444';
    let text = 'None';
    let width = '0%';

    if (val.length > 0) {
        if (score <= 2) {
            color = '#ef4444';
            text = 'Weak';
            width = '33%';
        } else if (score <= 4) {
            color = '#f59e0b';
            text = 'Medium';
            width = '66%';
        } else {
            color = '#10b981';
            text = 'Strong';
            width = '100%';
        }
    }

    strengthFill.style.width = width;
    strengthFill.style.backgroundColor = color;
    strengthText.textContent = `Password Strength: ${text}`;
    strengthText.style.color = color;

    evaluateConfirmPassword();
}

function evaluateConfirmPassword() {
    const pw = passwordInput.value;
    const cpw = confirmPasswordInput.value;

    if (!cpw) {
        confirmFeedback.textContent = '';
        return;
    }

    if (pw === cpw) {
        confirmFeedback.textContent = '✓ Passwords match';
        confirmFeedback.className = 'validation-feedback valid';
        confirmFeedback.style.color = '#10b981';
    } else {
        confirmFeedback.textContent = '✗ Passwords do not match';
        confirmFeedback.className = 'validation-feedback invalid';
        confirmFeedback.style.color = '#ef4444';
    }
}

function updateChecklistItem(el, isValid) {
    if (!el) return;
    if (isValid) {
        el.classList.add('valid');
        const icon = el.querySelector('.lucide');
        if (icon) icon.setAttribute('data-lucide', 'check-circle');
    } else {
        el.classList.remove('valid');
        const icon = el.querySelector('.lucide');
        if (icon) icon.setAttribute('data-lucide', 'x-circle');
    }
    if (window.lucide) lucide.createIcons();
}

function setupPasswordVisibilityToggles() {
    document.querySelectorAll('.eye-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const input = document.getElementById(targetId);
            const icon = btn.querySelector('.lucide');
            if (input && icon) {
                if (input.type === 'password') {
                    input.type = 'text';
                    icon.setAttribute('data-lucide', 'eye-off');
                } else {
                    input.type = 'password';
                    icon.setAttribute('data-lucide', 'eye');
                }
                if (window.lucide) lucide.createIcons();
            }
        });
    });
}

function setupAddressSync() {
    if (sameAddressCheck) {
        sameAddressCheck.addEventListener('change', () => {
            if (sameAddressCheck.checked) {
                corporateAddressInput.value = registeredAddressInput.value;
            }
        });
    }

    if (registeredAddressInput) {
        registeredAddressInput.addEventListener('input', () => {
            if (sameAddressCheck && sameAddressCheck.checked) {
                corporateAddressInput.value = registeredAddressInput.value;
            }
        });
    }
}

function setupLogoUpload() {
    if (logoFileInput) {
        logoFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (logoUploadStatus) {
                logoUploadStatus.innerHTML = '<span style="color: var(--primary);"><i data-lucide="loader" class="animate-spin"></i> Uploading brand logo to Firebase Storage...</span>';
                if (window.lucide) lucide.createIcons();
            }

            try {
                const storageRef = ref(storage, `organization_logos/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`);
                await uploadBytes(storageRef, file);
                const downloadUrl = await getDownloadURL(storageRef);

                logoUrlInput.value = downloadUrl;
                if (logoUploadStatus) {
                    logoUploadStatus.innerHTML = `<span style="color: #16a34a; font-weight: 600;">✓ Logo uploaded successfully (${file.name})</span>`;
                }
            } catch (err) {
                console.warn("Firebase Storage logo upload failed, setting local reference:", err.message);
                if (logoUploadStatus) {
                    logoUploadStatus.innerHTML = `<span style="color: #d97706;">Direct URL input active (Storage fallback)</span>`;
                }
            }
        });
    }
}

// ============================================================================
// 4. DEMO DATA 1-CLICK POPULATION
// ============================================================================

function setupDemoDataAutofill() {
    if (btnFillDemoSignup) {
        btnFillDemoSignup.onclick = () => {
            // Section A: CEO Account
            nameInput.value = "John Doe";
            emailInput.value = `ceo@kylrx.ai`;
            passwordInput.value = "Kylrx@Enterprise2026!";
            confirmPasswordInput.value = "Kylrx@Enterprise2026!";
            termsInput.checked = true;

            // Section B: Company Profile
            legalNameInput.value = "Kylrx Technologies Private Limited";
            displayNameInput.value = "Kylrx AI";
            orgTypeSelect.value = "Private Limited";
            industryInput.value = "Technology & Enterprise SaaS";
            websiteInput.value = "https://kylrx.ai";
            officialPhoneInput.value = "+91 80 4123 4567";
            logoUrlInput.value = "https://kylrx.ai/logo.jpg";

            // Section C: Address & Regional
            countryInput.value = "India";
            stateInput.value = "Karnataka";
            cityInput.value = "Bengaluru";
            pinCodeInput.value = "560103";
            registeredAddressInput.value = "Plot 42, Outer Ring Road, Bellandur, Bengaluru, Karnataka 560103";
            corporateAddressInput.value = "Floor 9, Tower C, Global Tech Park, Bellandur, Bengaluru, Karnataka 560103";
            timeZoneSelect.value = "Asia/Kolkata";
            currencySelect.value = "INR";
            fyStartSelect.value = "04-01";

            // Section D: Statutory Identifiers
            panInput.value = "AAACK1234F";
            tanInput.value = "BLRK12345D";
            cinInput.value = "U72200KA2026PTC123456";
            gstinInput.value = "29AAACK1234F1Z5";

            // Trigger real-time checklist events
            evaluatePasswordStrength();
            if (window.showAlert) {
                window.showAlert("Demo Data Populated", "All CEO credentials and 21 organization fields have been populated with Kylrx Enterprise defaults.", "check");
            }
        };
    }
}

// ============================================================================
// 5. MASTER SUBMISSION & PROVISIONING FLOW
// ============================================================================

function setupFormSubmission() {
    if (signupForm) {
        signupForm.onsubmit = async (e) => {
            e.preventDefault();

            // Validate all 4 sections
            if (!validateStep1()) { goToStep(1); return; }
            if (!validateStep2()) { goToStep(2); return; }
            if (!validateStep3()) { goToStep(3); return; }
            if (!validateStep4()) { goToStep(4); return; }

            await executeRegistrationAndOrganizationSetup();
        };
    }
}

async function executeRegistrationAndOrganizationSetup() {
    signupBtn.disabled = true;
    signupBtn.querySelector('span').innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Provisioning Organization & CEO Account...';
    if (window.lucide) lucide.createIcons();

    // 1. Gather all attributes
    const fullName = nameInput.value.trim();
    const officialEmail = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    const legalName = legalNameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const orgType = orgTypeSelect.value;
    const industry = industryInput.value.trim();
    const website = websiteInput.value.trim();
    const phone = officialPhoneInput.value.trim();
    const logoUrl = logoUrlInput.value.trim() || 'https://kylrx.ai/logo.jpg';

    const country = countryInput.value.trim() || 'India';
    const state = isUsSignup() ? stateInput.value.trim().toUpperCase() : stateInput.value.trim();
    const city = cityInput.value.trim();
    const pinCode = pinCodeInput.value.trim();
    const regAddress = registeredAddressInput.value.trim();
    const corpAddress = corporateAddressInput.value.trim() || regAddress;
    const timeZone = timeZoneSelect.value || 'Asia/Kolkata';
    const currency = currencySelect.value || 'INR';
    const fyStart = fyStartSelect.value || '04-01';

    const pan = panInput.value.trim().toUpperCase();
    const tan = tanInput.value.trim().toUpperCase();
    const cin = cinInput.value.trim().toUpperCase();
    const gstin = gstinInput.value.trim().toUpperCase();

    try {
        console.log(`🚀 Starting Customer/CEO Signup for ${officialEmail}...`);

        // Steps 1-4: The server creates the Auth user, Super Admin profile (/users/{uid}),
        // organization (21 attributes) and EMP0001 counter with the Admin SDK, because
        // Firestore rules (correctly) forbid clients from granting themselves super_admin.
        const apiBase = window.API_BASE || window.location.origin;
        const response = await fetch(`${apiBase}/api/auth/register-organization`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName,
                email: officialEmail,
                password,
                organization: {
                    legalName, displayName, organizationType: orgType, industry, website,
                    officialPhone: phone, logoUrl, country, state, city, pinCode,
                    registeredAddress: regAddress, corporateAddress: corpAddress,
                    timezone: timeZone, currency, financialYearStart: fyStart,
                    pan, tan, cinOrLlpin: cin, gstin
                }
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            // Error handlers may return `error` as a string or as { message }
            const detail = typeof result.error === 'string' ? result.error : (result.error?.message || result.message);
            const apiError = new Error(response.status === 404
                ? 'Signup service is unavailable. Please restart the Kylrx server (npm start) and try again.'
                : (detail || `Registration failed (HTTP ${response.status})`));
            apiError.code = result.code;
            throw apiError;
        }
        const orgId = result.orgId;
        console.log(`✅ Organization ${orgId} and Super Admin ${result.uid} provisioned`);

        // Sign in so the session carries the new super_admin custom claims
        await signInWithEmailAndPassword(auth, officialEmail, password);
        console.log(`✅ Signed in as ${officialEmail}`);

        // Step 5: Start a fresh session - drop everything left over from any previous
        // user/org (tokens, cached widgets, demo data) before writing the new session
        localStorage.clear();
        sessionStorage.clear();

        localStorage.setItem('hr_logged_in', 'true');
        localStorage.setItem('userRole', 'super_admin');
        localStorage.setItem('user_role', 'super_admin');
        localStorage.setItem('role', 'super_admin');
        localStorage.setItem('orgConfigured', 'true');
        localStorage.setItem('orgId', orgId);
        localStorage.setItem('user_email', officialEmail);
        localStorage.setItem('user_name', fullName);
        localStorage.setItem('companyName', displayName || legalName);

        // Step 6: Confirmation dialog & redirect directly to the main Super Admin Central Dashboard
        // replace() so the Back button can't return to the filled-in signup form
        window.customAlertCallback = () => {
            window.location.replace(isUsSignup() ? 'admin-dashboard.html' : 'admin-central-dashboard.html'); // the United States menu lives on admin-dashboard.html
        };

        if (window.showAlert) {
            window.showAlert(
                "Welcome to Kylrx AI!",
                `Account for "${fullName}" and Organization "${displayName}" successfully provisioned!\n\nSuper Admin role assigned and continuous sequential Employee ID provisioning (EMP0001) is active.\n\nRedirecting to Command Center...`,
                "check"
            );
        }

        setTimeout(() => {
            window.location.replace(isUsSignup() ? 'admin-dashboard.html' : 'admin-central-dashboard.html'); // the United States menu lives on admin-dashboard.html
        }, 2200);

    } catch (err) {
        console.error("Signup & Organization Setup Error:", err);
        if (err.code === 'auth/email-already-in-use') {
            showError("An account with this official email already exists. Please log in.");
        } else {
            showError(err.message || "Registration failed. Please check inputs and retry.");
        }
    } finally {
        signupBtn.disabled = false;
        signupBtn.querySelector('span').innerHTML = 'Complete Setup & Launch Dashboard &rarr;';
        if (window.lucide) lucide.createIcons();
    }
}

// Error presentation helpers
function showError(msg) {
    if (errorMessage) {
        errorMessage.textContent = msg;
        errorMessage.style.display = 'block';
        errorMessage.classList.add('shake');
        setTimeout(() => errorMessage.classList.remove('shake'), 500);
    }
}

function hideError() {
    if (errorMessage) {
        errorMessage.textContent = '';
        errorMessage.style.display = 'none';
    }
}
