/**
 * Upcoming Birthdays Widget Controller - Onn HR
 * Real-time Firestore sync, Chronological grouping, Live Countdowns, 
 * Leap-year logic, Role-based Isolation (HR vs Manager), and Interactive Birthday Wishes.
 */

import { db, auth, onSnapshot, registerListener } from './firebase-config.js';
import { collection, addDoc, serverTimestamp, query, where, getDocs, doc, setDoc } from './firebase-config.js';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_NAMES_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

class UpcomingBirthdaysController {
    constructor() {
        this.now = new Date();
        this.selectedYear = this.now.getFullYear();
        this.selectedMonth = this.now.getMonth(); // 0-indexed
        this.users = [];
        this.unsubscribe = null;
        this.config = {
            containerId: 'upcomingBirthdaysContainer',
            role: 'hr', // 'hr' | 'manager'
            managerId: null,
            managerName: null,
            managerDepartmentIds: [],
            displayLimit: 6,
            messagePageUrl: 'hrms-message.html'
        };
        this.selectedEmployeeForWish = null;
    }

    /**
     * Mount and initialize widget
     */
    init(options = {}) {
        this.config = { ...this.config, ...options };
        this.now = new Date();
        this.selectedYear = this.now.getFullYear();
        this.selectedMonth = this.now.getMonth();

        // Inject modals into DOM if not present
        this.ensureModalsExist();

        // Start listening to users
        this.listenUsers();

        // Update countdowns daily if dashboard stays open
        if (this._dailyInterval) clearInterval(this._dailyInterval);
        this._dailyInterval = setInterval(() => {
            this.now = new Date();
            this.render();
        }, 60000 * 30); // every 30 minutes
    }

    /**
     * Set / update manager filter parameters dynamically
     */
    setManagerScope(managerId, managerName, departmentIds = []) {
        this.config.role = 'manager';
        this.config.managerId = managerId;
        this.config.managerName = managerName;
        this.config.managerDepartmentIds = Array.isArray(departmentIds) ? departmentIds : [departmentIds].filter(Boolean);
        this.config.messagePageUrl = 'manager-message.html';
        this.render();
    }

    /**
     * Listen to Firestore 'users' collection with real-time updates
     */
    listenUsers() {
        if (this.unsubscribe) this.unsubscribe();

        const usersRef = collection(db, 'users');
        this.unsubscribe = onSnapshot(usersRef, (snapshot) => {
            const rawUsers = snapshot.docs.map(docSnap => ({
                id: docSnap.id,
                ...docSnap.data()
            }));

            this.users = rawUsers;
            this.render();
        }, (err) => {
            console.error('[UpcomingBirthdays] Error listening to users:', err);
            const container = document.getElementById(this.config.containerId);
            if (container) {
                container.innerHTML = `
                    <div class="birthday-panel">
                        <div class="birthday-empty-state">
                            <i data-lucide="alert-circle" style="width:36px;height:36px;color:#ef4444;margin-bottom:8px;"></i>
                            <h3>Unable to load birthdays</h3>
                            <p style="color:#ef4444;font-size:0.8rem;">Database connection error: ${err.message}</p>
                        </div>
                    </div>
                `;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    /**
     * Check if a year is a leap year
     */
    isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    }

    /**
     * Robust date of birth parser
     * Returns: { birthMonth (0-11), birthDay (1-31), isLeapDay (bool) } or null
     * CRITICAL: Strictly never returns birthYear for display
     */
    parseDOB(dobField) {
        if (!dobField) return null;

        let dateObj = null;

        // 1. Firestore Timestamp
        if (typeof dobField === 'object' && dobField !== null) {
            if (typeof dobField.toDate === 'function') {
                dateObj = dobField.toDate();
            } else if (dobField._seconds || dobField.seconds) {
                const s = dobField._seconds || dobField.seconds;
                dateObj = new Date(s * 1000);
            }
        }

        // 2. String representation
        if (!dateObj && typeof dobField === 'string') {
            const trimmed = dobField.trim();

            // YYYY-MM-DD or YYYY/MM/DD
            const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
            if (isoMatch) {
                const y = parseInt(isoMatch[1], 10);
                const m = parseInt(isoMatch[2], 10) - 1;
                const d = parseInt(isoMatch[3], 10);
                return {
                    birthMonth: m,
                    birthDay: d,
                    birthYear: y,
                    isLeapDay: (m === 1 && d === 29)
                };
            }

            // DD-MM-YYYY or DD/MM/YYYY
            const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
            if (dmyMatch) {
                const d = parseInt(dmyMatch[1], 10);
                const m = parseInt(dmyMatch[2], 10) - 1;
                const y = parseInt(dmyMatch[3], 10);
                return {
                    birthMonth: m,
                    birthDay: d,
                    birthYear: y,
                    isLeapDay: (m === 1 && d === 29)
                };
            }

            // Fallback to Date parser
            const parsed = new Date(trimmed);
            if (!isNaN(parsed.getTime())) {
                dateObj = parsed;
            }
        }

        if (dateObj instanceof Date && !isNaN(dateObj.getTime())) {
            const m = dateObj.getMonth();
            const d = dateObj.getDate();
            const y = dateObj.getFullYear();
            return {
                birthMonth: m,
                birthDay: d,
                birthYear: y,
                isLeapDay: (m === 1 && d === 29)
            };
        }

        return null;
    }

    /**
     * Filter users according to role permissions (HR vs Manager)
     */
    getPermittedUsers() {
        if (!Array.isArray(this.users)) return [];

        // Exclude system accounts without person names or inactive/suspended if required
        const base = this.users.filter(u => {
            if (!u || u.status === 'Trash' || u.status === 'Suspended') return false;
            if (u.hideBirthday === true) return false;
            // Exclude non-human placeholder docs
            if (u.id === 'EMP_A' && !u.name) return false;
            return true;
        });

        // HR Role sees ALL employees
        if (this.config.role === 'hr' || this.config.role === 'admin' || this.config.role === 'superadmin') {
            return base;
        }

        // Manager Role: strictly filter by permitted unit/department or direct reportees
        const allowedUnits = (this.config.managerDepartmentIds || []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
        const mgrName = (this.config.managerName || '').toLowerCase().trim();
        const mgrId = (this.config.managerId || '').trim();

        return base.filter(u => {
            // Check direct manager match
            if (mgrName && u.reportingManager && u.reportingManager.toLowerCase().includes(mgrName)) return true;
            if (mgrId && (u.managerId === mgrId || u.reportingManager === mgrId)) return true;

            // Check department match
            const uDeptId = (u.departmentId || '').toLowerCase().trim();
            const uDeptName = (u.departmentName || u.department || '').toLowerCase().trim();
            const uDeptCode = (u.departmentCode || '').toLowerCase().trim();

            if (allowedUnits.length > 0) {
                return allowedUnits.includes(uDeptId) || 
                       allowedUnits.includes(uDeptName) || 
                       allowedUnits.includes(uDeptCode);
            }

            return true;
        });
    }

    /**
     * Calculate countdown logic for an employee's birthday in the selected month & year
     */
    calculateCountdown(birthDay, birthMonth, isLeapDay) {
        const today = new Date(this.now.getFullYear(), this.now.getMonth(), this.now.getDate());
        const curYear = this.selectedYear;
        const curMonth = this.selectedMonth;

        // Handle leap-day in non-leap year (celebrated / observed Feb 28)
        let effectiveDay = birthDay;
        let isObserved = false;
        if (isLeapDay && !this.isLeapYear(curYear)) {
            effectiveDay = 28;
            isObserved = true;
        }

        const bdayThisYear = new Date(curYear, curMonth, effectiveDay);
        const msPerDay = 1000 * 60 * 60 * 24;
        const diffDays = Math.round((bdayThisYear - today) / msPerDay);

        let countdownText = '';
        let status = 'upcoming'; // 'today' | 'upcoming' | 'passed'

        if (diffDays === 0) {
            status = 'today';
            countdownText = 'Today 🎂';
        } else if (diffDays === 1) {
            status = 'upcoming';
            countdownText = '1 day to go';
        } else if (diffDays > 1) {
            status = 'upcoming';
            countdownText = `${diffDays} days to go`;
        } else if (diffDays === -1) {
            status = 'passed';
            countdownText = 'Passed (yesterday)';
        } else {
            status = 'passed';
            const pastDays = Math.abs(diffDays);
            countdownText = `Passed (${pastDays} days ago)`;
        }

        const monthName = MONTH_NAMES[birthMonth];
        const monthShort = MONTH_NAMES_SHORT[birthMonth];
        
        // Strictly Month + Day ONLY (No Year)
        let formattedDate = `${monthName} ${birthDay}`;
        if (isObserved) {
            formattedDate += ' (Observed Feb 28)';
        }

        return {
            diffDays,
            status,
            countdownText,
            formattedDate,
            monthShort,
            day: birthDay
        };
    }

    /**
     * Navigate Month Selector
     */
    prevMonth() {
        this.selectedMonth--;
        if (this.selectedMonth < 0) {
            this.selectedMonth = 11;
            this.selectedYear--;
        }
        this.render();
    }

    nextMonth() {
        this.selectedMonth++;
        if (this.selectedMonth > 11) {
            this.selectedMonth = 0;
            this.selectedYear++;
        }
        this.render();
    }

    jumpToToday() {
        this.now = new Date();
        this.selectedYear = this.now.getFullYear();
        this.selectedMonth = this.now.getMonth();
        this.render();
    }

    setMonthAndYear(monthIdx, year) {
        this.selectedMonth = parseInt(monthIdx, 10);
        this.selectedYear = parseInt(year, 10);
        this.render();
    }

    /**
     * Generate Avatar with high-contrast initials and dynamic color
     */
    renderAvatar(emp) {
        const name = emp.name || emp.displayName || 'Team Member';
        const photo = emp.photoURL || emp.avatar || emp.profilePic;

        if (photo) {
            return `
                <img src="${photo}" alt="${name}" class="bday-avatar" onerror="this.onerror=null; this.outerHTML='${this.getInitialsAvatar(name)}'">
            `;
        }
        return this.getInitialsAvatar(name);
    }

    getInitialsAvatar(name) {
        const initials = name
            .split(' ')
            .map(n => n[0])
            .filter(Boolean)
            .join('')
            .substring(0, 2)
            .toUpperCase() || 'TM';

        const colorSchemes = [
            { bg: '#fee2e2', text: '#dc2626' }, // rose
            { bg: '#fef3c7', text: '#d97706' }, // amber
            { bg: '#ecfdf5', text: '#059669' }, // emerald
            { bg: '#eff6ff', text: '#2563eb' }, // blue
            { bg: '#f5f3ff', text: '#7c3aed' }, // violet
            { bg: '#fdf2f8', text: '#db2777' }  // pink
        ];

        const charCode = (initials.charCodeAt(0) || 65) + (initials.charCodeAt(1) || 66);
        const scheme = colorSchemes[charCode % colorSchemes.length];

        return `
            <div class="bday-avatar" style="background:${scheme.bg}; color:${scheme.text};">
                ${initials}
            </div>
        `;
    }

    /**
     * Core Render Method
     */
    render() {
        const container = document.getElementById(this.config.containerId);
        if (!container) return;

        const permitted = this.getPermittedUsers();

        // Process birthdays for all permitted users
        const validBirthdayUsers = [];

        permitted.forEach(u => {
            const parsed = this.parseDOB(u.dob || u.dateOfBirth || u.birthDate);
            if (!parsed) return;

            // Only consider selected month for primary widget view
            if (parsed.birthMonth === this.selectedMonth) {
                const countdown = this.calculateCountdown(parsed.birthDay, parsed.birthMonth, parsed.isLeapDay);
                validBirthdayUsers.push({
                    user: u,
                    parsed,
                    countdown
                });
            }
        });

        // Sort chronologically by day of month (ascending 1..31)
        validBirthdayUsers.sort((a, b) => a.parsed.birthDay - b.parsed.birthDay);

        // Group multiple birthdays on the same day (Requirement 5)
        const dateGroups = [];
        const groupMap = new Map();

        validBirthdayUsers.forEach(item => {
            const dayKey = item.parsed.birthDay;
            if (!groupMap.has(dayKey)) {
                groupMap.set(dayKey, {
                    day: dayKey,
                    formattedDate: item.countdown.formattedDate,
                    countdownText: item.countdown.countdownText,
                    status: item.countdown.status,
                    diffDays: item.countdown.diffDays,
                    items: []
                });
            }
            groupMap.get(dayKey).items.push(item);
        });

        groupMap.forEach(group => {
            dateGroups.push(group);
        });

        // Calculate Summary Stats (Requirement 6)
        const totalThisMonth = validBirthdayUsers.length;
        const birthdaysToday = validBirthdayUsers.filter(i => i.countdown.status === 'today').length;

        // Next upcoming birthday (lowest non-negative diffDays)
        let nextUpcoming = validBirthdayUsers.find(i => i.countdown.diffDays >= 0);
        
        // If none upcoming in this month, look in future months for next upcoming birthday
        if (!nextUpcoming) {
            const allWithDob = [];
            permitted.forEach(u => {
                const parsed = this.parseDOB(u.dob || u.dateOfBirth || u.birthDate);
                if (parsed) {
                    const today = new Date(this.now.getFullYear(), this.now.getMonth(), this.now.getDate());
                    let targetYear = this.now.getFullYear();
                    let targetDate = new Date(targetYear, parsed.birthMonth, parsed.birthDay);
                    if (targetDate < today) {
                        targetYear++;
                        targetDate = new Date(targetYear, parsed.birthMonth, parsed.birthDay);
                    }
                    const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
                    allWithDob.push({ user: u, parsed, diffDays, targetDate });
                }
            });
            allWithDob.sort((a, b) => a.diffDays - b.diffDays);
            if (allWithDob.length > 0) {
                const next = allWithDob[0];
                const dText = next.diffDays === 0 ? 'Today 🎂' : (next.diffDays === 1 ? '1 day to go' : `${next.diffDays} days to go`);
                nextUpcoming = {
                    user: next.user,
                    countdown: {
                        formattedDate: `${MONTH_NAMES_SHORT[next.parsed.birthMonth]} ${next.parsed.birthDay}`,
                        countdownText: dText,
                        diffDays: next.diffDays,
                        status: next.diffDays === 0 ? 'today' : 'upcoming'
                    }
                };
            }
        }

        // Render HTML
        const isCurrentMonthView = (this.selectedYear === this.now.getFullYear() && this.selectedMonth === this.now.getMonth());
        const selectedMonthLabel = `${MONTH_NAMES[this.selectedMonth]} ${this.selectedYear}`;

        let summaryHtml = `
            <div class="birthday-summary-grid">
                <div class="bday-summary-card">
                    <div class="bday-sum-icon pink">
                        <i data-lucide="cake"></i>
                    </div>
                    <div class="bday-sum-details">
                        <div class="bday-sum-label">This Month</div>
                        <div class="bday-sum-val">${totalThisMonth}</div>
                        <div class="bday-sum-sub">${MONTH_NAMES[this.selectedMonth]} Birthdays</div>
                    </div>
                </div>

                <div class="bday-summary-card">
                    <div class="bday-sum-icon amber">
                        <i data-lucide="party-popper"></i>
                    </div>
                    <div class="bday-sum-details">
                        <div class="bday-sum-label">Birthday Today</div>
                        <div class="bday-sum-val">
                            ${birthdaysToday}
                            ${birthdaysToday > 0 ? '<span class="today-pulse-dot" title="Celebrate Today!"></span>' : ''}
                        </div>
                        <div class="bday-sum-sub">${birthdaysToday === 1 ? '1 Celebrant Today' : `${birthdaysToday} Celebrants`}</div>
                    </div>
                </div>

                <div class="bday-summary-card">
                    <div class="bday-sum-icon blue">
                        <i data-lucide="sparkles"></i>
                    </div>
                    <div class="bday-sum-details">
                        <div class="bday-sum-label">Next Birthday</div>
                        <div class="bday-sum-val" title="${nextUpcoming ? nextUpcoming.user.name : 'None scheduled'}">
                            ${nextUpcoming ? (nextUpcoming.user.name || 'Team Member') : 'None'}
                        </div>
                        <div class="bday-sum-sub">
                            ${nextUpcoming ? `${nextUpcoming.countdown.formattedDate}` : 'No upcoming birthdays'}
                        </div>
                    </div>
                </div>

                <div class="bday-summary-card">
                    <div class="bday-sum-icon purple">
                        <i data-lucide="hourglass"></i>
                    </div>
                    <div class="bday-sum-details">
                        <div class="bday-sum-label">Next Countdown</div>
                        <div class="bday-sum-val">
                            ${nextUpcoming ? (nextUpcoming.countdown.status === 'today' ? 'Today 🎂' : `⏳ ${nextUpcoming.countdown.diffDays} ${nextUpcoming.countdown.diffDays === 1 ? 'day' : 'days'}`) : '—'}
                        </div>
                        <div class="bday-sum-sub">
                            ${nextUpcoming ? (nextUpcoming.countdown.status === 'today' ? 'Active celebration!' : `${nextUpcoming.countdown.countdownText}`) : 'Up to date'}
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Build Month Dropdown options
        let monthOptionsHtml = '';
        for (let m = 0; m < 12; m++) {
            const isSel = (m === this.selectedMonth);
            monthOptionsHtml += `<option value="${m}" ${isSel ? 'selected' : ''}>${MONTH_NAMES[m]} ${this.selectedYear}</option>`;
        }

        // Build Birthdays List HTML
        let groupsHtml = '';
        if (dateGroups.length === 0) {
            groupsHtml = `
                <div class="birthday-empty-state">
                    <div class="birthday-empty-icon">
                        <i data-lucide="calendar-off" size="28"></i>
                    </div>
                    <h3>No birthdays in ${selectedMonthLabel}</h3>
                    <p>There are no employee birthdays scheduled for ${selectedMonthLabel} in your team scope. Try switching months above.</p>
                </div>
            `;
        } else {
            groupsHtml = `<div class="birthday-groups-container">`;

            dateGroups.forEach(group => {
                const isTodayGroup = group.status === 'today';
                const pillClass = group.status === 'today' ? 'today' : (group.status === 'passed' ? 'passed' : 'upcoming');
                const pillIcon = group.status === 'today' ? '🎂' : (group.status === 'passed' ? '✓' : '⏳');

                groupsHtml += `
                    <div class="birthday-date-group ${isTodayGroup ? 'is-today-group' : ''}">
                        <div class="birthday-group-header">
                            <div class="group-date-badge">
                                <i data-lucide="calendar"></i>
                                <span>${group.formattedDate}</span>
                                ${group.items.length > 1 ? `<span style="font-size:0.75rem; color:#6366f1; background:#e0e7ff; padding:2px 8px; border-radius:10px; font-weight:700;">${group.items.length} Birthdays</span>` : ''}
                            </div>
                            <span class="group-countdown-pill ${pillClass}">
                                <span>${pillIcon}</span>
                                <span>${group.countdownText}</span>
                            </span>
                        </div>

                        <div class="birthday-members-grid">
                `;

                group.items.forEach(({ user: emp, countdown }) => {
                    const isToday = countdown.status === 'today';
                    const name = emp.name || emp.displayName || 'Team Member';
                    const dept = emp.departmentName || emp.department || 'General';
                    const role = emp.designation || (emp.role === 'manager' ? 'Lead Manager' : 'Team Member');

                    groupsHtml += `
                        <div class="birthday-member-card ${isToday ? 'is-today-card' : ''}">
                            ${isToday ? `
                                <div class="bday-today-banner">
                                    <span>🎂</span> Birthday Today!
                                </div>
                            ` : ''}

                            <div class="member-top-row">
                                ${this.renderAvatar(emp)}
                                <div class="bday-member-details">
                                    <div class="bday-member-name" title="${name}">${name}</div>
                                    <div class="bday-member-role" title="${role}">${role}</div>
                                    <div class="bday-member-dept">
                                        <i data-lucide="building-2" style="width:12px;height:12px;"></i>
                                        <span>${dept}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="member-bottom-row">
                                <span class="bday-date-tag">
                                    <i data-lucide="gift" style="width:13px;height:13px;color:#db2777;"></i>
                                    <span>${countdown.formattedDate}</span>
                                </span>
                                <span class="bday-countdown-tag tag-${countdown.status}">
                                    ${isToday ? '🎂 Today!' : (countdown.status === 'passed' ? '✓ Passed' : `⏳ ${countdown.countdownText}`)}
                                </span>
                            </div>

                            ${isToday ? `
                                <button class="btn-wish-action" onclick="window.UpcomingBirthdaysInstance.openWishModal('${emp.id}')">
                                    <i data-lucide="send" style="width:14px;height:14px;"></i>
                                    <span>Send Birthday Wish</span>
                                </button>
                            ` : ''}
                        </div>
                    `;
                });

                groupsHtml += `
                        </div>
                    </div>
                `;
            });

            groupsHtml += `</div>`;
        }

        container.innerHTML = `
            <div class="birthday-panel">
                <div class="birthday-header">
                    <div class="birthday-title-wrap">
                        <div class="birthday-icon-badge">🎂</div>
                        <div class="birthday-title-text">
                            <h2>
                                <span>Upcoming Birthdays</span>
                                <span style="font-size:0.75rem; background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:6px; font-weight:700;">
                                    ${this.config.role === 'hr' ? 'All Personnel' : 'Team Scope'}
                                </span>
                            </h2>
                            <p>Live countdowns and monthly celebrations across your workforce</p>
                        </div>
                    </div>

                    <div class="birthday-controls">
                        <div class="month-stepper">
                            <button class="month-step-btn" title="Previous Month" onclick="window.UpcomingBirthdaysInstance.prevMonth()">
                                <i data-lucide="chevron-left" style="width:16px;height:16px;"></i>
                            </button>
                            <select class="month-select" id="bdayMonthSelect" onchange="window.UpcomingBirthdaysInstance.setMonthAndYear(this.value, ${this.selectedYear})">
                                ${monthOptionsHtml}
                            </select>
                            <button class="month-step-btn" title="Next Month" onclick="window.UpcomingBirthdaysInstance.nextMonth()">
                                <i data-lucide="chevron-right" style="width:16px;height:16px;"></i>
                            </button>
                        </div>

                        ${!isCurrentMonthView ? `
                            <button class="btn-today-jump" onclick="window.UpcomingBirthdaysInstance.jumpToToday()">
                                <i data-lucide="rotate-ccw" style="width:12px;height:12px;"></i>
                                <span>Current Month</span>
                            </button>
                        ` : ''}

                        <button class="btn-view-all-modal" onclick="window.UpcomingBirthdaysInstance.openAllBirthdaysModal()">
                            <i data-lucide="users" style="width:14px;height:14px;"></i>
                            <span>View All (${permitted.length})</span>
                        </button>
                    </div>
                </div>

                ${summaryHtml}
                ${groupsHtml}
            </div>
        `;

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    /**
     * Ensure Modals for Wish and View All exist in document.body
     */
    ensureModalsExist() {
        if (!document.getElementById('birthdayWishModal')) {
            const wishModalHtml = `
                <div class="bday-modal-overlay" id="birthdayWishModal">
                    <div class="bday-modal-card">
                        <div class="bday-modal-header">
                            <div class="bday-modal-title">
                                <span style="font-size: 1.5rem;">🎉</span>
                                <div>
                                    <h3>Send Birthday Wish</h3>
                                    <p style="font-size:0.75rem; color:#831843; margin:0;">Deliver personal greetings & team recognition</p>
                                </div>
                            </div>
                            <button class="month-step-btn" onclick="document.getElementById('birthdayWishModal').style.display='none'">
                                <i data-lucide="x" style="width:18px;height:18px;"></i>
                            </button>
                        </div>
                        <div class="bday-modal-body">
                            <div id="wishRecipientInfo"></div>

                            <label style="font-size:0.75rem; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.04em; display:block; margin-bottom:6px;">
                                Quick Greetings:
                            </label>
                            <div class="bday-quick-picks">
                                <button type="button" class="bday-pick-btn" onclick="window.UpcomingBirthdaysInstance.applyQuickPick(1)">
                                    🎉 "Wishing you a very Happy Birthday! May your year ahead be filled with great joy and continued success!"
                                </button>
                                <button type="button" class="bday-pick-btn" onclick="window.UpcomingBirthdaysInstance.applyQuickPick(2)">
                                    🎂 "Happy Birthday from all of us! Thank you for being such an awesome and inspiring member of our team!"
                                </button>
                                <button type="button" class="bday-pick-btn" onclick="window.UpcomingBirthdaysInstance.applyQuickPick(3)">
                                    🌟 "Warmest birthday wishes! Wishing you good health, happiness, and outstanding achievements this year!"
                                </button>
                            </div>

                            <label style="font-size:0.75rem; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.04em; display:block; margin-bottom:6px;">
                                Custom Message:
                            </label>
                            <textarea class="bday-wish-textarea" id="bdayWishCustomText" placeholder="Write your personalized birthday greeting..."></textarea>

                            <div style="margin-top:1rem; display:flex; align-items:center; gap:8px; font-size:0.8rem; color:#475569;">
                                <input type="checkbox" id="bdayNotifyBell" checked style="accent-color:#6366f1;">
                                <label for="bdayNotifyBell">Post to Direct Messaging & send system notification</label>
                            </div>

                            <div class="bday-modal-footer">
                                <button type="button" class="btn-today-jump" style="background:#f1f5f9; color:#475569; border-color:#e2e8f0;" onclick="document.getElementById('birthdayWishModal').style.display='none'">
                                    Cancel
                                </button>
                                <button type="button" class="btn-wish-action" style="width:auto; padding:10px 20px;" id="btnSubmitBirthdayWish" onclick="window.UpcomingBirthdaysInstance.submitBirthdayWish()">
                                    <i data-lucide="send" style="width:14px;height:14px;"></i>
                                    <span>Send Celebration Wish</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', wishModalHtml);
        }

        if (!document.getElementById('allBirthdaysModal')) {
            const allModalHtml = `
                <div class="bday-modal-overlay" id="allBirthdaysModal">
                    <div class="bday-modal-card" style="max-width: 680px; max-height: 85vh; display:flex; flex-direction:column;">
                        <div class="bday-modal-header" style="background: linear-gradient(135deg, #f0fdf4 0%, #eff6ff 100%);">
                            <div class="bday-modal-title">
                                <i data-lucide="calendar-heart" style="width:24px;height:24px;color:#2563eb;"></i>
                                <div>
                                    <h3 style="color:#1e3a8a;">Annual Birthday Directory</h3>
                                    <p style="font-size:0.75rem; color:#475569; margin:0;">Complete chronological workforce birthday calendar</p>
                                </div>
                            </div>
                            <button class="month-step-btn" onclick="document.getElementById('allBirthdaysModal').style.display='none'">
                                <i data-lucide="x" style="width:18px;height:18px;"></i>
                            </button>
                        </div>
                        <div style="padding:1rem 1.5rem; border-bottom:1px solid #e2e8f0; background:#f8fafc; display:flex; gap:10px; align-items:center;">
                            <i data-lucide="search" style="width:16px;height:16px;color:#94a3b8;"></i>
                            <input type="text" id="allBdaySearchInput" placeholder="Filter personnel or department..." oninput="window.UpcomingBirthdaysInstance.filterAllDirectory(this.value)" style="flex:1; border:none; background:transparent; font-size:0.85rem; font-family:inherit; outline:none;">
                            <span style="font-size:0.75rem; color:#64748b; font-weight:700;" id="allBdayCountBadge"></span>
                        </div>
                        <div class="bday-modal-body" style="overflow-y:auto; flex:1; padding:1.25rem;" id="allBirthdaysListContainer">
                            <!-- Populated dynamically -->
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', allModalHtml);
        }

        if (window.lucide) lucide.createIcons();
    }

    /**
     * Open Send Birthday Wish Modal for a specific employee
     */
    openWishModal(empId) {
        const emp = this.users.find(u => u.id === empId);
        if (!emp) return;

        this.selectedEmployeeForWish = emp;
        const name = emp.name || emp.displayName || 'Team Member';
        const role = emp.designation || (emp.role === 'manager' ? 'Lead Manager' : 'Team Member');
        const dept = emp.departmentName || emp.department || 'General';

        const infoBox = document.getElementById('wishRecipientInfo');
        if (infoBox) {
            infoBox.innerHTML = `
                <div class="bday-recipient-card">
                    ${this.renderAvatar(emp)}
                    <div>
                        <div style="font-size:0.95rem; font-weight:800; color:#0f172a;">${name}</div>
                        <div style="font-size:0.75rem; color:#64748b;">${role} • ${dept}</div>
                    </div>
                </div>
            `;
        }

        const customText = document.getElementById('bdayWishCustomText');
        if (customText) {
            customText.value = `🎉 Wishing you a wonderful Happy Birthday, ${name}! Wishing you joy, good health, and continued success! 🎂✨`;
        }

        const modal = document.getElementById('birthdayWishModal');
        if (modal) modal.style.display = 'flex';

        if (window.lucide) lucide.createIcons();
    }

    applyQuickPick(num) {
        const emp = this.selectedEmployeeForWish;
        const name = emp ? (emp.name || emp.displayName || 'friend') : 'friend';
        const customText = document.getElementById('bdayWishCustomText');
        if (!customText) return;

        if (num === 1) {
            customText.value = `🎉 Wishing you a very Happy Birthday, ${name}! May your year ahead be filled with great joy and continued success! 🎂✨`;
        } else if (num === 2) {
            customText.value = `🎂 Happy Birthday ${name} from all of us! Thank you for being such an awesome and inspiring member of our team! 🌟`;
        } else {
            customText.value = `🌟 Warmest birthday wishes, ${name}! Wishing you good health, happiness, and outstanding achievements this year! 🎈`;
        }
    }

    /**
     * Submit Birthday Wish
     */
    async submitBirthdayWish() {
        const emp = this.selectedEmployeeForWish;
        if (!emp) return;

        const textInput = document.getElementById('bdayWishCustomText');
        const message = textInput ? textInput.value.trim() : '';
        if (!message) return;

        const btn = document.getElementById('btnSubmitBirthdayWish');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Sending...`;
            if (window.lucide) lucide.createIcons();
        }

        try {
            const senderName = localStorage.getItem('hrms_manager_name') || 
                               localStorage.getItem('userName') || 
                               (this.config.role === 'manager' ? (this.config.managerName || 'Department Manager') : 'Human Resources');
            const senderId = auth.currentUser ? auth.currentUser.uid : (localStorage.getItem('hr_user_id') || 'hr_admin_sender');

            // 1. Send push notification to recipient in Firestore
            await addDoc(collection(db, 'notifications'), {
                type: 'birthday_wish',
                title: `🎂 Birthday Wish from ${senderName}`,
                body: message,
                recipientId: emp.id,
                recipientUid: emp.uid || emp.id,
                senderId: senderId,
                senderName: senderName,
                timestamp: serverTimestamp(),
                read: false,
                celebration: true
            });

            // 2. Direct message in conversations if exists
            try {
                const convId = [senderId, emp.id].sort().join('__');
                await setDoc(doc(db, 'conversations', convId), {
                    type: 'direct',
                    participants: [senderId, emp.id],
                    lastMessage: message.slice(0, 100),
                    lastMessageAt: serverTimestamp(),
                    unread: { [emp.id]: 1, [senderId]: 0 }
                }, { merge: true });

                await addDoc(collection(db, 'conversations', convId, 'messages'), {
                    senderId,
                    senderName,
                    senderRole: this.config.role,
                    text: message,
                    timestamp: serverTimestamp(),
                    isBirthdayWish: true,
                    read: false
                });
            } catch (convErr) {
                console.warn('[UpcomingBirthdays] Could not save direct chat message:', convErr);
            }

            // Close modal & Trigger celebratory Confetti
            const modal = document.getElementById('birthdayWishModal');
            if (modal) modal.style.display = 'none';

            this.triggerConfetti();

            // Display Toast notification
            this.showToast(`🎉 Birthday wish successfully delivered to ${emp.name || 'employee'}!`);

        } catch (err) {
            console.error('[UpcomingBirthdays] Failed to send wish:', err);
            alert(`Could not send wish: ${err.message}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i data-lucide="send" style="width:14px;height:14px;"></i> <span>Send Celebration Wish</span>`;
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    /**
     * Trigger Confetti Celebration Animation
     */
    triggerConfetti() {
        const colors = ['#ec4899', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ef4444', '#ffd700'];
        const numParticles = 40;

        for (let i = 0; i < numParticles; i++) {
            const p = document.createElement('div');
            p.className = 'confetti-particle';
            p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            p.style.left = `${Math.random() * 100}vw`;
            p.style.top = `-10px`;
            p.style.width = `${Math.random() * 8 + 6}px`;
            p.style.height = `${Math.random() * 12 + 6}px`;
            p.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
            p.style.animationDuration = `${Math.random() * 2 + 1.5}s`;
            p.style.animationDelay = `${Math.random() * 0.4}s`;
            document.body.appendChild(p);

            setTimeout(() => {
                p.remove();
            }, 3000);
        }
    }

    /**
     * Show clean toast message
     */
    showToast(message) {
        const toast = document.createElement('div');
        toast.style.position = 'fixed';
        toast.style.bottom = '24px';
        toast.style.right = '24px';
        toast.style.background = '#0f172a';
        toast.style.color = '#ffffff';
        toast.style.padding = '12px 20px';
        toast.style.borderRadius = '12px';
        toast.style.fontSize = '0.85rem';
        toast.style.fontWeight = '700';
        toast.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.3)';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '10px';
        toast.style.zIndex = '1000000';
        toast.style.animation = 'bdayModalPop 0.3s ease';
        toast.innerHTML = `<span>🎂</span> <span>${message}</span>`;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 400);
        }, 3500);
    }

    /**
     * Open Directory of All Birthdays Modal
     */
    openAllBirthdaysModal() {
        const modal = document.getElementById('allBirthdaysModal');
        if (!modal) return;
        modal.style.display = 'flex';
        this.filterAllDirectory('');
        if (window.lucide) lucide.createIcons();
    }

    filterAllDirectory(query) {
        const container = document.getElementById('allBirthdaysListContainer');
        const badge = document.getElementById('allBdayCountBadge');
        if (!container) return;

        const permitted = this.getPermittedUsers();
        const q = (query || '').toLowerCase().trim();

        const allWithDob = [];
        permitted.forEach(u => {
            const parsed = this.parseDOB(u.dob || u.dateOfBirth || u.birthDate);
            if (!parsed) return;

            const name = (u.name || u.displayName || '').toLowerCase();
            const dept = (u.departmentName || u.department || '').toLowerCase();
            const role = (u.designation || '').toLowerCase();

            if (q && !name.includes(q) && !dept.includes(q) && !role.includes(q)) {
                return;
            }

            const countdown = this.calculateCountdown(parsed.birthDay, parsed.birthMonth, parsed.isLeapDay);
            allWithDob.push({ user: u, parsed, countdown });
        });

        // Group by month (January to December)
        allWithDob.sort((a, b) => {
            if (a.parsed.birthMonth !== b.parsed.birthMonth) {
                return a.parsed.birthMonth - b.parsed.birthMonth;
            }
            return a.parsed.birthDay - b.parsed.birthDay;
        });

        if (badge) badge.textContent = `${allWithDob.length} Records`;

        if (allWithDob.length === 0) {
            container.innerHTML = `
                <div style="padding:2.5rem; text-align:center; color:#94a3b8; font-size:0.85rem;">
                    No matching birthdays found.
                </div>
            `;
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:1.25rem;">';
        let currentMonth = -1;

        allWithDob.forEach(({ user: emp, parsed, countdown }) => {
            if (parsed.birthMonth !== currentMonth) {
                currentMonth = parsed.birthMonth;
                html += `
                    <div style="position:sticky; top:0; background:#f8fafc; padding:6px 12px; border-radius:8px; font-weight:800; font-size:0.85rem; color:#4338ca; border:1px solid #e0e7ff; margin-top:6px;">
                        ${MONTH_NAMES[currentMonth]}
                    </div>
                `;
            }

            const name = emp.name || emp.displayName || 'Team Member';
            const role = emp.designation || 'Team Member';
            const dept = emp.departmentName || emp.department || 'General';

            html += `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#ffffff; border:1px solid #f1f5f9; border-radius:12px;">
                    <div style="display:flex; align-items:center; gap:12px;">
                        ${this.renderAvatar(emp)}
                        <div>
                            <div style="font-weight:700; font-size:0.88rem; color:#0f172a;">${name}</div>
                            <div style="font-size:0.74rem; color:#64748b;">${role} • ${dept}</div>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:800; font-size:0.82rem; color:#db2777;">${countdown.formattedDate}</div>
                        <div style="font-size:0.72rem; color:#64748b; font-weight:600;">${countdown.countdownText}</div>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    }
}

// Global Singleton Instance
window.UpcomingBirthdaysInstance = new UpcomingBirthdaysController();

export const upcomingBirthdays = window.UpcomingBirthdaysInstance;
export default UpcomingBirthdaysController;
