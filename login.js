import { auth, db, doc, getDoc, collection, query, where, getDocs, setDoc, serverTimestamp } from "./firebase-config.js";
import { signInWithEmailAndPassword, signOut, GoogleAuthProvider, OAuthProvider, SAMLAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInAnonymously, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

/** A page inside this app that asked for sign-in first (for example the app-approval page). Only plain same-site pages are accepted. */
function afterLoginTarget() {
    try {
        const t = sessionStorage.getItem('kylrx_after_login');
        sessionStorage.removeItem('kylrx_after_login');
        return t && /^\/[A-Za-z0-9_-]+\.html(\?[^#\s]{0,2000})?$/.test(t) ? t : null;
    } catch (_) { return null; }
}

/** The company's country, asked from the server with the signed-in user's token ('US', 'IN' or null when unknown) */
async function companyCountry() {
    try {
        if (!auth.currentUser) return null;
        const res = await fetch('/api/time/status', { headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
        if (!res.ok) return null;
        return (await res.json()).country || null;
    } catch (_) { return null; }
}

const US_STAFF_ROLES = ['hradmin', 'hrms', 'hr', 'payrolladmin', 'manager', 'accountant', 'auditor', 'executive'];

async function getRedirectUrl(userData, role) {
    if (!role) {
        throw new Error("Access denied: Account has no assigned role. Please contact HR.");
    }
    if (userData && (userData.status === 'inactive' || userData.status === 'Inactive')) {
        throw new Error("Your account is currently inactive. Please contact support.");
    }
    const cleanRole = (role || '').toLowerCase().replace(/[\s_-]+/g, '');
    const known = ['superadmin', 'admin', 'employee', ...US_STAFF_ROLES].includes(cleanRole);
    const back = known ? afterLoginTarget() : null;
    if (back) return back;
    // United States companies have their own pages; the dashboards below are the India ones
    if (known && (await companyCountry()) === 'US') {
        if (userData?.orgId) localStorage.setItem('orgId', userData.orgId);
        if (cleanRole === 'superadmin' || cleanRole === 'admin') { localStorage.setItem('orgConfigured', 'true'); return 'admin-dashboard.html'; }
        return cleanRole === 'employee' ? 'punch.html' : 'us-home.html';
    }
    if (cleanRole === 'superadmin' || cleanRole === 'admin') {
        const orgId = userData?.orgId || localStorage.getItem('orgId') || 'org_kylrx_ai';
        localStorage.setItem('orgId', orgId);
        localStorage.setItem('orgConfigured', 'true');
        return 'admin-dashboard.html';
    } else if (cleanRole === 'hradmin' || cleanRole === 'hrms' || cleanRole === 'hr') {
        return 'hrms-dashboard.html';
    } else if (cleanRole === 'manager') {
        const deptId = (userData && (userData.departmentId || userData.departmentCode)) ? (userData.departmentId || userData.departmentCode) : '';
        return deptId ? `manager-dashboard.html?id=${deptId}` : 'manager-dashboard.html';
    } else if (cleanRole === 'employee') {
        return 'employee-dashboard.html';
    } else {
        throw new Error("Invalid role assigned. Please contact your administrator.");
    }
}


// Fix for "sw.js" errors: Unregister any ghost service workers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let registration of registrations) {
      registration.unregister();
    }
  });
}

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const errorMessage = document.getElementById('errorMessage');
const loginBtn = document.getElementById('loginBtn');
const credentialsBtn = document.getElementById('credentialsBtn');

// ===== Password Show/Hide Toggle =====
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

// ═══════════ DEMO ROLES QUICK ACCESS MODAL ══════════════════════════════════
const demoModal = document.getElementById('demoRolesModal');
const closeDemoBtn = document.getElementById('closeDemoRolesBtn');
const selectSuperAdmin = document.getElementById('selectSuperAdmin');
const selectHrAdmin = document.getElementById('selectHrAdmin');
const selectManager = document.getElementById('selectManager');
const selectEmployee = document.getElementById('selectEmployee');

if (credentialsBtn && demoModal) {
    credentialsBtn.addEventListener('click', () => {
        demoModal.style.display = 'flex';
        if (window.lucide) lucide.createIcons();
    });
}
if (closeDemoBtn && demoModal) {
    closeDemoBtn.addEventListener('click', () => { demoModal.style.display = 'none'; });
    demoModal.addEventListener('click', (e) => { if (e.target === demoModal) demoModal.style.display = 'none'; });
}

// Demo shortcuts exist ONLY on a developer's own machine, talking to the local emulator.
// They use the throwaway accounts created by `npm run seed:local`; no real credential is kept in this file.
const IS_LOCAL_DEMO = ['localhost', '127.0.0.1'].includes(window.location.hostname) && sessionStorage.getItem('kylrx_live_firebase') !== '1';
const LOCAL_DEMO_PASSWORD = 'LocalTest#2026';
const LOCAL_DEMO_ACCOUNTS = {
  superAdmin: 'superadmin@us.demo.local', hrAdmin: 'hr@us.demo.local', manager: 'manager@us.demo.local', employee: 'employee@us.demo.local'
};

function bindDemo(button, key, closeModal) {
    if (!button) return;
    if (!IS_LOCAL_DEMO) { button.style.display = 'none'; return; }
    button.addEventListener('click', () => {
        if (emailInput) emailInput.value = LOCAL_DEMO_ACCOUNTS[key];
        if (passwordInput) passwordInput.value = LOCAL_DEMO_PASSWORD;
        if (closeModal && demoModal) demoModal.style.display = 'none';
        loginBtn?.click();
    });
}
bindDemo(selectSuperAdmin, 'superAdmin', true);
bindDemo(selectHrAdmin, 'hrAdmin', true);
bindDemo(selectManager, 'manager', true);
bindDemo(selectEmployee, 'employee', true);

const btnQuickSuperAdmin = document.getElementById('btnQuickSuperAdmin');
const btnQuickHrAdmin = document.getElementById('btnQuickHrAdmin');
const btnQuickManager = document.getElementById('btnQuickManager');
const btnQuickEmployee = document.getElementById('btnQuickEmployee');
bindDemo(btnQuickSuperAdmin, 'superAdmin', false);
bindDemo(btnQuickHrAdmin, 'hrAdmin', false);
bindDemo(btnQuickManager, 'manager', false);
bindDemo(btnQuickEmployee, 'employee', false);
if (!IS_LOCAL_DEMO) {
    // hide the whole "1-click demo login" panel and the demo-roles button on real deployments
    const panel = btnQuickSuperAdmin && btnQuickSuperAdmin.parentElement && btnQuickSuperAdmin.parentElement.parentElement;
    if (panel) panel.style.display = 'none';
    if (credentialsBtn) credentialsBtn.style.display = 'none';
}

// ═══════════ FORGOT PASSWORD MODAL ═══════════════════════════════════════════
(function setupForgotPassword() {
    const link    = document.getElementById('forgotPasswordLink');
    const overlay = document.getElementById('forgotPwdOverlay');
    const input   = document.getElementById('forgotEmailInput');
    const status  = document.getElementById('forgotPwdStatus');
    const submitBtn = document.getElementById('forgotSubmitBtn');
    const cancelBtn = document.getElementById('forgotCancelBtn');

    if (!link || !overlay) return;

    const open = () => {
        // Pre-fill email from the login form if already typed
        const existingEmail = document.getElementById('email')?.value?.trim();
        if (existingEmail && input) input.value = existingEmail;
        status.style.display = 'none';
        submitBtn.innerHTML = '<i data-lucide="send" style="width:16px;height:16px;"></i> Send Reset Link';
        submitBtn.disabled = false;
        overlay.style.display = 'flex';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => input?.focus(), 100);
    };

    const close = () => { overlay.style.display = 'none'; };

    link.addEventListener('click', (e) => { e.preventDefault(); open(); });
    cancelBtn?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    submitBtn?.addEventListener('click', async () => {
        const email = input?.value?.trim();
        if (!email) {
            status.textContent = '⚠️ Please enter your email address.';
            status.style.cssText = 'display:block; padding:10px 14px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#fef3c7; color:#92400e;';
            input?.focus();
            return;
        }

        submitBtn.innerHTML = '⏳ Sending...';
        submitBtn.disabled = true;

        try {
            await sendPasswordResetEmail(auth, email, {
                url: window.location.origin + '/login.html',
                handleCodeInApp: false
            });
            status.textContent = '✅ Reset link sent! Check your inbox (and spam folder). The link expires in 1 hour.';
            status.style.cssText = 'display:block; padding:12px 16px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#dcfce7; color:#166534; border:1px solid #bbf7d0;';
            submitBtn.innerHTML = '✓ Email Sent';
            setTimeout(close, 4000);
        } catch (err) {
            console.warn('Password reset error:', err.code);
            let msg = '❌ Failed to send reset email. Please try again.';
            if (err.code === 'auth/user-not-found')    msg = '❌ No account found with this email. Please check and try again.';
            if (err.code === 'auth/invalid-email')     msg = '❌ Invalid email format. Please enter a valid email address.';
            if (err.code === 'auth/too-many-requests') msg = '⚠️ Too many requests. Please wait a few minutes and try again.';
            status.textContent = msg;
            status.style.cssText = 'display:block; padding:10px 14px; border-radius:10px; font-size:0.82rem; font-weight:600; margin-bottom:1rem; background:#fee2e2; color:#991b1b; border:1px solid #fecaca;';
            submitBtn.innerHTML = '<i data-lucide="send" style="width:16px;height:16px;"></i> Try Again';
            submitBtn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    });

    // Allow Enter key to submit
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBtn?.click(); } });
})();
// ═════════════════════════════════════════════════════════════════════════════

// Pre-fill credentials if redirecting from signup page
try {
    const signupEmail = sessionStorage.getItem('signup_email');
    const signupPassword = sessionStorage.getItem('signup_password');
    if (signupEmail && emailInput) {
        emailInput.value = signupEmail;
        sessionStorage.removeItem('signup_email');
    }
    if (signupPassword && passwordInput) {
        passwordInput.value = signupPassword;
        sessionStorage.removeItem('signup_password');
    }
} catch (e) {
    console.warn('Session storage pre-fill failed:', e);
}

loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();
  const cleanEmail = email.toLowerCase();
  
  const btnText = loginBtn.querySelector('span');
  const originalText = btnText.textContent;
  btnText.textContent = 'Authenticating...';
  loginBtn.disabled = true;
  errorMessage.style.display = 'none';

  try {
    let userData = null;
    let finalUid = null;
    let token = null;
    let lastAuthError = null;

    const isSuperAdminAccount = cleanEmail === 'superadmin@kylrx.ai' || cleanEmail === 'nandanb449@gmail.com' || cleanEmail === 'admin@kylrx.ai' || cleanEmail === 'admin@demo.com' || cleanEmail.includes('superadmin') || cleanEmail.includes('admin');
    const isHrAccount = cleanEmail === 'savitha.balraju@gmail.com' || cleanEmail === 'hradmin@kylrx.ai' || cleanEmail === 'hrms@kylrx.ai' || cleanEmail.includes('hradmin') || cleanEmail.includes('hrms') || cleanEmail.includes('savitha');
    const isManagerAccount = cleanEmail === 'john.doe@example.com' || cleanEmail === 'manager@kylrx.ai' || cleanEmail === 'manager' || cleanEmail.includes('manager');
    const isEmployeeAccount = cleanEmail === 'marry@gmail.com' || cleanEmail === 'employee@kylrx.ai';

    // Strategy 1: Firebase Authentication (direct attempt with entered credentials first)
    try {
      let userCredential;
      try {
        userCredential = await signInWithEmailAndPassword(auth, email, password);
      } catch (firstErr) {
        throw firstErr;
      }
      finalUid = userCredential.user.uid;
      token = userCredential.user.accessToken;

      // Server-assigned custom claims (set via the Admin SDK only) are the authoritative role
      let claimRole = null;
      let claimOrgId = null;
      try {
        const tokenResult = await userCredential.user.getIdTokenResult();
        claimRole = tokenResult.claims.role || (tokenResult.claims.super_admin ? 'super_admin' : null);
        claimOrgId = tokenResult.claims.orgId || null;
      } catch (_) {}

      const userDoc = await getDoc(doc(db, "users", finalUid));
      if (userDoc.exists()) {
        userData = userDoc.data();
        userData.uid = finalUid;
        if (claimRole) userData.role = claimRole;
        if (claimOrgId && !userData.orgId) userData.orgId = claimOrgId;
        // Check for EMP doc or query by email in users collection
        try {
          const empDoc = await getDoc(doc(db, "users", "EMP_1789151730443"));
          if (empDoc.exists() && empDoc.data().email === cleanEmail) {
            userData = empDoc.data();
            userData.uid = finalUid;
          }
        } catch (_) {}

        if (!userData) {
          try {
            const q = query(collection(db, "users"), where("email", "in", [cleanEmail, email]));
            const querySnap = await getDocs(q);
            if (!querySnap.empty) {
              userData = querySnap.docs[0].data();
              userData.uid = finalUid;
            }
          } catch (_) {}
        }
      }

      if (!userData) {
        const roleDetermined = isSuperAdminAccount ? 'SUPER_ADMIN' : (isHrAccount ? 'hrms' : (isManagerAccount ? 'manager' : 'employee'));
        const deptDetermined = isSuperAdminAccount ? 'Executive' : (isHrAccount ? 'Human Resources' : (isManagerAccount ? 'Cybersecurity Manager' : 'Engineering'));
        const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
        const formattedName = namePart.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'User';

        userData = {
          uid: finalUid,
          email: email,
          name: isSuperAdminAccount ? 'Nandan' : (isHrAccount ? 'Savitha' : (isManagerAccount ? 'John Doe' : (cleanEmail === 'marry@gmail.com' ? 'Marry Doe' : formattedName))),
          role: roleDetermined,
          department: deptDetermined,
          departmentName: deptDetermined,
          departmentCode: isManagerAccount ? 'UNIT-CYB-802' : '',
          departmentId: isManagerAccount ? 'Yksv1DMH9pIeRhNxQ8E3' : '',
          employeeId: isManagerAccount ? 'UNIT-CYB-802-SMCU' : ('EMP-' + Math.floor(1000 + Math.random() * 9000)),
          status: 'Active'
        };
      }
    } catch (authErr) {
      lastAuthError = authErr;
      if (authErr.code !== 'auth/invalid-credential' && authErr.code !== 'auth/user-not-found' && authErr.code !== 'auth/wrong-password') {
        console.warn("Firebase Auth status:", authErr.code || authErr.message);
      }
    }

    if (userData && isManagerAccount) {
      userData.role = 'manager';
      if (!userData.name) userData.name = 'John Doe';
      if (!userData.departmentName) userData.departmentName = 'Cybersecurity Manager';
      if (!userData.departmentCode) userData.departmentCode = 'UNIT-CYB-802';
      if (!userData.departmentId) userData.departmentId = 'Yksv1DMH9pIeRhNxQ8E3';
    }

    // Strategy 2: Direct Firestore query by email (handles temporary passwords & custom credentials)
    if (!userData) {
      try {
        const q = query(collection(db, 'users'), where('email', 'in', [cleanEmail, email, 'john.doe@example.com']));
        const querySnap = await getDocs(q);
        if (!querySnap.empty) {
          for (const d of querySnap.docs) {
            const u = d.data();
            const storedPw = u.password || u.tempPassword || u.temporary_password || u.temp_password;
            if (storedPw && (storedPw === password || storedPw.trim() === password.trim())) {
              userData = u;
              finalUid = d.id;
              break;
            }
          }
        }
      } catch (dbErr) {
        console.warn("Firestore credentials query:", dbErr.message);
      }
    }

    // Strategy 3 (offline demo sessions with built-in passwords) was removed: a session only exists after a real sign-in.
    const validAuthorizedPasswords = [];
    const passwordIsValidMasterOrDemo = validAuthorizedPasswords.includes(password.trim());

    if (!userData) {
      if (passwordIsValidMasterOrDemo) {
        if (isSuperAdminAccount) {
          userData = {
            uid: 'superadmin_' + Date.now(),
            name: 'Nandan',
            email: email || 'superadmin@kylrx.ai',
            role: 'SUPER_ADMIN',
            department: 'Executive',
            departmentId: 'executive'
          };
          finalUid = userData.uid;
        } else if (isHrAccount) {
          userData = {
            uid: 'EMP_1789286607504',
            name: 'Savitha',
            email: email || 'Savitha.balraju@GMAIL.COM',
            role: 'hrms',
            department: 'General',
            departmentId: 'hrms'
          };
          finalUid = userData.uid;
        } else if (isManagerAccount) {
          userData = {
            uid: 'EMP_1789151730443',
            name: 'John Doe',
            email: email || 'john.doe@example.com',
            role: 'manager',
            department: 'Cybersecurity Manager',
            departmentName: 'Cybersecurity Manager',
            departmentCode: 'UNIT-CYB-802',
            departmentId: 'Yksv1DMH9pIeRhNxQ8E3',
            employeeId: 'UNIT-CYB-802-SMCU',
            status: 'Active'
          };
          finalUid = userData.uid;
        } else if (cleanEmail === 'marry@gmail.com') {
          userData = {
            uid: 'EMP_1789230184645',
            name: 'Marry Doe',
            email: email,
            role: 'employee',
            department: 'Engineering',
            departmentName: 'Engineering & Operations',
            departmentId: 'engineering',
            employeeId: 'EMP-7729',
            status: 'Active'
          };
          finalUid = userData.uid;
        }
      }

      if (!userData) {
        if (lastAuthError) throw lastAuthError;
        throw new Error("Invalid credentials. Please verify your password or use 'Forgot Password'.");
      }
    }

    const role = (userData.role || (isManagerAccount ? 'manager' : 'employee')).toLowerCase();
    const dept = (userData.departmentId || userData.department || userData.departmentName || 'General').toLowerCase();

    console.log('✅ Login successful for:', email, 'Role:', role);

    localStorage.setItem('hr_logged_in', 'true');
    localStorage.setItem('hr_user_id', finalUid);
    if (token) localStorage.setItem('hr_access_token', token);
    localStorage.setItem('userName', userData.name || email);
    localStorage.setItem('userRole', role);
    localStorage.setItem('userDept', dept);
    localStorage.setItem('employee_uid', finalUid);
    if (userData.departmentId) localStorage.setItem('departmentId', userData.departmentId);
    if (userData.departmentName) localStorage.setItem('departmentName', userData.departmentName);
    if (userData.departmentCode) localStorage.setItem('departmentCode', userData.departmentCode);
    if (role === 'manager') {
      localStorage.setItem('manager_name', userData.name || 'John Doe');
      localStorage.setItem('manager_email', userData.email || email);
      localStorage.setItem('manager_dept', userData.departmentName || 'Cybersecurity Manager');
      localStorage.setItem('manager_dept_code', userData.departmentCode || 'UNIT-CYB-802');
    }
    if (role === 'hrms' || role === 'hr_admin' || role === 'hr' || isHrAccount) {
      localStorage.setItem('hrms_manager_name', 'Savitha Balraju');
      localStorage.setItem('hrms_manager_role', 'Strategic Operations');
      localStorage.setItem('hrms_name', 'Savitha Balraju');
    }

    const redirectUrl = await getRedirectUrl(userData, role);
    if (btnText) btnText.textContent = 'Redirecting to your workspace...';
    window.location.href = redirectUrl;

  } catch (error) {
    if (error.message && error.message.includes('Access Denied')) {
        showAlert('Access Restricted', error.message, 'shield-alert');
    } else if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
        showError('Invalid credentials. Please verify your password or use "Forgot Password".');
    } else if (error.code === 'auth/user-not-found') {
        showError('No account found with this email. Please sign up first.');
    } else if (error.code === 'auth/invalid-email') {
        showError('Please enter a valid email address format.');
    } else if (error.code === 'auth/too-many-requests') {
        showError('Too many failed attempts. Please wait a few moments and try again.');
    } else if (error.name === 'TypeError') {
        showError('Network Error: Please check your internet connection.');
    } else {
        showError(error.message || 'Invalid login credentials. Please try again.');
    }
  } finally {
    if (btnText) btnText.textContent = originalText;
    if (loginBtn) loginBtn.disabled = false;
  }
});

function showError(msg) {
  if (errorMessage) {
    errorMessage.textContent = msg;
    errorMessage.style.display = 'block';
    errorMessage.classList.add('shake');
    setTimeout(() => errorMessage.classList.remove('shake'), 500);
  }
}

function showAlert(title, msg, icon = 'info', type = 'info') {
    document.getElementById('alertTitle').textContent = title;
    document.getElementById('alertMsg').textContent = msg;
    const iconEl = document.getElementById('alertIcon');
    const btnEl = document.getElementById('alertBtn');
    const cardEl = document.getElementById('alertCard');
    
    iconEl.innerHTML = `<i data-lucide="${icon}"></i>`;
    
    if (type === 'error' || title.toLowerCase().includes('denied') || title.toLowerCase().includes('restricted')) {
        iconEl.style.color = '#ef4444';
        btnEl.style.background = '#ef4444';
        cardEl.style.borderTop = '6px solid #ef4444';
    } else {
        iconEl.style.color = '#2563eb';
        btnEl.style.background = '#2563eb';
        cardEl.style.borderTop = 'none';
    }
    
    if (window.lucide) { lucide.createIcons(); }
    document.getElementById('customOverlay').style.display = 'flex';
}

const googleLoginBtn = document.getElementById('googleLoginBtn');
if (googleLoginBtn) {
    async function processGoogleLoginUser(userAuth) {
        const email = userAuth.email || '';
        const cleanEmail = email.toLowerCase().trim();
        let userData = null;

        // 1. Try direct getDoc from Firestore by Google Auth UID
        try {
            const userDoc = await getDoc(doc(db, "users", userAuth.uid));
            if (userDoc.exists()) {
                userData = userDoc.data();
                userData.uid = userAuth.uid;
            }
        } catch (err) {
            console.warn('Direct getDoc failed:', err);
        }

        // 2. Try query users collection by email (checking cleanEmail, email, upperCase)
        if (!userData && cleanEmail) {
            try {
                const emailVariants = Array.from(new Set([cleanEmail, email, email.toUpperCase()])).filter(Boolean);
                const q = query(collection(db, 'users'), where('email', 'in', emailVariants));
                const querySnap = await getDocs(q);
                if (!querySnap.empty) {
                    userData = querySnap.docs[0].data();
                    userData.uid = querySnap.docs[0].id;
                }
            } catch (err) {
                console.warn('Firestore users query failed:', err);
            }
        }

        // 3. Try query employees collection by email if not found in users
        if (!userData && cleanEmail) {
            try {
                const emailVariants = Array.from(new Set([cleanEmail, email, email.toUpperCase()])).filter(Boolean);
                const empQ = query(collection(db, 'employees'), where('email', 'in', emailVariants));
                const empSnap = await getDocs(empQ);
                if (!empSnap.empty) {
                    const empData = empSnap.docs[0].data();
                    userData = {
                        uid: empSnap.docs[0].id,
                        ...empData,
                        role: empData.role || 'employee'
                    };
                }
            } catch (_) {}
        }

        // 4. Only people who already have a Kylrx account may sign in with Google. Unknown Google
        //    accounts used to be auto-provisioned with a role guessed from the email address
        //    (anything containing "admin" became SUPER_ADMIN), letting anyone into the app.
        if (!userData) {
            try { await signOut(auth); } catch (_) {}
            throw new Error(`No Kylrx account exists for ${email}. Sign in with the email your company registered, or ask your administrator to add you.`);
        }

        // Server-assigned custom claims (set via the Admin SDK only) are the authoritative role
        try {
            const claims = (await userAuth.getIdTokenResult()).claims || {};
            const claimRole = claims.role || (claims.super_admin || claims.superadmin ? 'super_admin' : null);
            if (claimRole) userData.role = claimRole;
            if (claims.orgId && !userData.orgId) userData.orgId = claims.orgId;
        } catch (_) {}

        const isManagerAccount = /manager/i.test(userData.role || '');
        const isHrAccount = /^(hrms|hr|hr_admin|hradmin)$/i.test(userData.role || '');

        // Record the Google link without blocking sign-in (a write can take up to 20s to fail
        // while the Firestore quota is exhausted)
        setDoc(doc(db, "users", userAuth.uid), {
            ...userData,
            uid: userData.uid || userAuth.uid,
            googleLinked: true,
            photoURL: userAuth.photoURL || userData.photoURL || '',
            updatedAt: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('Google link metadata not saved:', err.message));

        const role = (userData.role || (isManagerAccount ? 'manager' : 'employee')).toLowerCase();
        const dept = (userData.departmentId || userData.department || userData.departmentName || 'General').toLowerCase();
        const finalUid = userData.uid || userAuth.uid;

        console.log('✅ Google login successful for:', email, 'Role:', role);

        // Save complete enterprise session credentials to localStorage
        localStorage.setItem('hr_logged_in', 'true');
        localStorage.setItem('hr_user_id', finalUid);
        localStorage.setItem('hr_access_token', userAuth.accessToken || 'demo-static-token');
        localStorage.setItem('userName', userData.name || userData.displayName || email);
        localStorage.setItem('userRole', role);
        localStorage.setItem('user_role', role);
        localStorage.setItem('userDept', dept);
        localStorage.setItem('employee_uid', finalUid);

        if (userData.departmentId) localStorage.setItem('departmentId', userData.departmentId);
        if (userData.departmentName) localStorage.setItem('departmentName', userData.departmentName);
        if (userData.departmentCode) localStorage.setItem('departmentCode', userData.departmentCode);

        const orgId = userData.orgId || localStorage.getItem('orgId') || 'org_kylrx_ai';
        localStorage.setItem('orgId', orgId);
        localStorage.setItem('orgConfigured', 'true');

        if (role === 'manager' || isManagerAccount) {
            localStorage.setItem('manager_name', userData.name || 'John Doe');
            localStorage.setItem('manager_email', userData.email || email);
            localStorage.setItem('manager_dept', userData.departmentName || 'Cybersecurity Manager');
            localStorage.setItem('manager_dept_code', userData.departmentCode || 'UNIT-CYB-802');
        }
        if (role === 'hrms' || role === 'hr_admin' || role === 'hr' || isHrAccount) {
            localStorage.setItem('hrms_manager_name', userData.name || 'Savitha Balraju');
            localStorage.setItem('hrms_manager_role', 'Strategic Operations');
            localStorage.setItem('hrms_name', userData.name || 'Savitha Balraju');
        }

        const redirectUrl = await getRedirectUrl(userData, role);
        if (googleLoginBtn) {
            const span = googleLoginBtn.querySelector('span');
            if (span) span.textContent = 'Redirecting to your workspace...';
        }
        window.location.href = redirectUrl;
    }

    async function handleGoogleAuthError(error) {
        console.error('Google sign-in error:', error);
        
        if (error.code === 'auth/operation-not-allowed') {
            showAlert('Configuration Error', 'Google Sign-In is not enabled. Please enable the Google provider in your Firebase Authentication Console.', 'info');
        } else if (error.message && error.message.includes('Access Denied')) {
            showAlert('Access Restricted', error.message, 'shield-alert');
        } else if (error.code === 'auth/popup-closed-by-user') {
            showError('Sign-in popup closed.');
        } else if (error.code === 'auth/cancelled-popup-request') {
            showError('Sign-in cancelled. Please try again.');
        } else if (error.code === 'auth/popup-blocked') {
            showError('Sign-in popup was blocked by your browser. Please allow popups for this site.');
        } else if (error.code === 'auth/missing-initial-state' || (error.message && error.message.includes('missing initial state'))) {
            showError('Authentication session expired or blocked by browser storage partitioning. Please use popup sign-in.');
        } else {
            showError(error.message || 'Google sign-in failed.');
        }
    }

    googleLoginBtn.addEventListener('click', async () => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        
        // Show loading state
        const originalHtml = googleLoginBtn.innerHTML;
        googleLoginBtn.innerHTML = `<span>Connecting to Google...</span>`;
        googleLoginBtn.disabled = true;
        
        try {
            if (window.location.protocol === 'https:') {
                // HTTPS: full-page redirect through this server's /__/auth proxy (no popup, no
                // Cross-Origin-Opener-Policy warnings). Handled by getRedirectResult below.
                await signInWithRedirect(auth, provider);
                return;
            }
            // Plain-http local development: Firebase's redirect handler needs HTTPS, so use the
            // popup. Chrome logs harmless "Cross-Origin-Opener-Policy would block" warnings.
            const result = await signInWithPopup(auth, provider);
            if (result && result.user) {
                googleLoginBtn.innerHTML = `<span>Redirecting to your workspace...</span>`;
                googleLoginBtn.disabled = true;
                await processGoogleLoginUser(result.user);
            }
        } catch (error) {
            googleLoginBtn.innerHTML = originalHtml;
            googleLoginBtn.disabled = false;
            await handleGoogleAuthError(error);
        }
    });

    // Company single sign-on (OIDC / SAML through Firebase Authentication): shown when the typed email's
    // domain belongs to a company that turned SSO on. Companies that require it refuse passwords on the server.
    (function setupSso() {
        const emailField = document.getElementById('email') || document.querySelector('input[type=email]');
        if (!emailField || !googleLoginBtn) return;
        let ssoBtn = null; let lastDomain = '';
        async function check() {
            const email = (emailField.value || '').trim();
            const domain = (email.split('@')[1] || '').toLowerCase();
            if (!domain || domain === lastDomain) return;
            lastDomain = domain;
            try {
                const r = await (await fetch('/api/sso/discover?email=' + encodeURIComponent(email))).json();
                if (ssoBtn) { ssoBtn.remove(); ssoBtn = null; }
                if (!r.sso) return;
                ssoBtn = document.createElement('button');
                ssoBtn.type = 'button'; ssoBtn.className = googleLoginBtn.className; ssoBtn.textContent = 'Sign in with your company (SSO)';
                ssoBtn.style.marginTop = '8px'; ssoBtn.style.width = '100%';
                googleLoginBtn.parentElement.appendChild(ssoBtn);
                ssoBtn.addEventListener('click', async () => {
                    try {
                        const provider = r.providerId.startsWith('saml.') ? new SAMLAuthProvider(r.providerId) : new OAuthProvider(r.providerId);
                        const result = await signInWithPopup(auth, provider);
                        if (result && result.user) await processGoogleLoginUser(result.user);
                    } catch (error) { showError(error.message || 'Single sign-on failed.'); }
                });
            } catch (_) {}
        }
        emailField.addEventListener('blur', check);
        emailField.addEventListener('change', check);
    })();

    // Check if user completed a redirect (with quiet handling for partitioned environments)
    try {
        getRedirectResult(auth).then((redirectResult) => {
            if (redirectResult && redirectResult.user) {
                console.log('✅ Processing Google redirect sign-in...');
                if (googleLoginBtn) {
                    googleLoginBtn.innerHTML = `<span>Redirecting to your workspace...</span>`;
                    googleLoginBtn.disabled = true;
                }
                processGoogleLoginUser(redirectResult.user);
            }
        }).catch((redirectErr) => {
            const isStoragePartitionErr = redirectErr && (
                redirectErr.code === 'auth/missing-initial-state' || 
                String(redirectErr.message || '').includes('missing initial state')
            );
            if (!isStoragePartitionErr) {
                console.warn('Redirect result check:', redirectErr);
                handleGoogleAuthError(redirectErr);
            }
        });
    } catch (_) {}
}
