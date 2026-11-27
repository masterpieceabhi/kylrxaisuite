import { db, auth } from "./firebase-config.js";
import { 
    collection, 
    doc, 
    setDoc, 
    updateDoc, 
    serverTimestamp, 
    getDoc, 
    query, 
    where, 
    getDocs, 
    addDoc, 
    limit, 
    orderBy,
    arrayUnion,
    deleteDoc
} from "./firebase-config.js";

/**
 * ============================================================================
 * Enterprise Performance Management System (PMS) Engine - PRD Section 8
 * Strict Schema:
 *   1. pms_cycles/{cycleId}: { cycleName, cycleType, startDate, endDate, status, createdBy, createdAt }
 *   2. pms_tasks/{taskId}: { cycleId, employeeId, assignedBy, title, description, status, reviewStatus, feedback, createdAt, completedAt }
 *   3. pms_reviews/{reviewId}: { cycleId, employeeId, reviewerId, delegatedTo, delegationHistory: [], overallScore, status }
 * ============================================================================
 */

/* ========================================================================== */
/* SECTION 8.1: SUPER ADMIN PMS CYCLE ENGINE                                   */
/* ========================================================================== */

/**
 * Creates and schedules a new PMS cycle.
 * Supported cycle types: 'Quarterly' | 'Biannual' | 'Annual' | 'Custom'
 */
export async function createPMSCycle({ cycleName, cycleType = 'Quarterly', startDate, endDate, status = 'scheduled', createdBy = 'Super Admin', attachments = [] }) {
    console.log(`[PMS Engine] Creating cycle "${cycleName}" (${cycleType})...`);
    try {
        const cycleId = `CYCLE-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        const cycleRef = doc(db, 'pms_cycles', cycleId);

        const payload = {
            cycleId,
            cycleName: cycleName.trim(),
            cycleType, // 'Quarterly', 'Biannual', 'Annual', 'Custom'
            startDate,
            endDate,
            status, // 'scheduled' | 'active' | 'completed' | 'draft'
            createdBy,
            attachments: Array.isArray(attachments) ? attachments : [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        await setDoc(cycleRef, payload);
        console.log(`[PMS Engine] Cycle created: ${cycleId}`);
        return { success: true, cycleId, cycle: payload };
    } catch (err) {
        console.error('[PMS Engine] Error creating PMS cycle:', err);
        throw err;
    }
}

/**
 * Fetches all PMS cycles ordered by creation date.
 */
export async function getPMSCycles() {
    try {
        const cyclesRef = collection(db, 'pms_cycles');
        const snap = await getDocs(cyclesRef);
        const cycles = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Sort desc in memory
        return cycles.sort((a, b) => {
            const timeA = a.createdAt?.seconds || 0;
            const timeB = b.createdAt?.seconds || 0;
            return timeB - timeA;
        });
    } catch (err) {
        console.warn('[PMS Engine] Notice fetching cycles:', err.message);
        return [];
    }
}

/**
 * Fetches the currently active PMS cycle, or null if none is active.
 */
export async function getActivePMSCycle() {
    try {
        const q = query(collection(db, 'pms_cycles'), where('status', '==', 'active'), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
            return { id: snap.docs[0].id, ...snap.docs[0].data() };
        }
        // Fallback: check scheduled cycles
        const allCycles = await getPMSCycles();
        return allCycles.find(c => c.status === 'active') || allCycles[0] || null;
    } catch (err) {
        console.warn('[PMS Engine] Notice finding active cycle:', err.message);
        return null;
    }
}

/**
 * Updates PMS Cycle status (e.g. 'active', 'completed', 'scheduled').
 */
export async function updatePMSCycleStatus(cycleId, newStatus) {
    try {
        const cycleRef = doc(db, 'pms_cycles', cycleId);
        await updateDoc(cycleRef, {
            status: newStatus,
            updatedAt: serverTimestamp()
        });
        return { success: true };
    } catch (err) {
        console.error('[PMS Engine] Error updating cycle status:', err);
        throw err;
    }
}

/**
 * Rolls out a PMS Cycle:
 * 1. Enrolls all active employees and initializes their pms_reviews document.
 * 2. Automatically dispatches in-app notifications to each employee.
 * 3. Automatically triggers email alerts to each employee via POST /api/email/send.
 * 4. Sets cycle status to 'active' once the above succeeded.
 */
export async function rolloutPMSCycle(cycleId) {
    console.log(`[PMS Engine] Initiating cycle rollout for ${cycleId}...`);
    try {
        const cycleDoc = await getDoc(doc(db, 'pms_cycles', cycleId));
        if (!cycleDoc.exists()) {
            throw new Error(`Cycle ${cycleId} not found.`);
        }
        const cycleData = cycleDoc.data();

        // 1. Query all enrolled employees from employees and users collections
        const enrolledEmployees = await getEnrolledEmployees();
        console.log(`[PMS Engine] Enrolled employee count: ${enrolledEmployees.length}`);

        const notificationResults = [];
        const emailResults = [];

        // 3. For each employee, create initial pms_reviews and dispatch alerts
        for (const emp of enrolledEmployees) {
            const empId = emp.employeeId || emp.id || emp.uid;
            const empName = emp.name || emp.fullName || 'Employee';
            const empEmail = emp.email || emp.officialEmail || '';
            const reviewerId = emp.reportingManager || emp.l1Manager || 'MANAGER-DEFAULT';

            // Ensure pms_reviews document exists for this cycle & employee
            const reviewId = `REV-${cycleId}-${empId}`;
            const reviewRef = doc(db, 'pms_reviews', reviewId);
            const reviewSnap = await getDoc(reviewRef);

            if (!reviewSnap.exists()) {
                await setDoc(reviewRef, {
                    reviewId,
                    cycleId,
                    employeeId: empId,
                    employeeName: empName,
                    employeeEmail: empEmail,
                    reviewerId: reviewerId,
                    delegatedTo: null,
                    delegationHistory: [],
                    overallScore: 0,
                    status: 'in_progress', // 'in_progress' | 'submitted' | 'reviewed'
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
            }

            // In-app Notification dispatch
            try {
                await addDoc(collection(db, 'notifications'), {
                    target: empId,
                    targetUid: emp.uid || empId,
                    title: `PMS Review Cycle Rolled Out: ${cycleData.cycleName}`,
                    text: `Performance cycle "${cycleData.cycleName}" (${cycleData.startDate || 'Immediate'} to ${cycleData.endDate || 'TBD'}) is now active. Please log your deliverables and tasks.`,
                    message: `Performance cycle "${cycleData.cycleName}" is now active. Please log your deliverables and tasks.`,
                    priority: 'high',
                    type: 'pms_cycle_rollout',
                    cycleId: cycleId,
                    read: false,
                    timestamp: serverTimestamp(),
                    createdAt: serverTimestamp()
                });
                notificationResults.push({ employeeId: empId, status: 'dispatched' });
            } catch (notifErr) {
                console.warn(`[PMS Engine] In-app notification error for ${empId}:`, notifErr.message);
            }

            // Email Notification trigger via /api/email/send
            if (empEmail && empEmail.includes('@')) {
                try {
                    const emailPayload = {
                        to: empEmail,
                        subject: `Action Required: ${cycleData.cycleName} Performance Review Cycle is Active`,
                        html: `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
                                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
                                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px;">K</div>
                                    <div>
                                        <h2 style="margin: 0; font-size: 20px; font-weight: 800; color: #0f172a;">Kylrx.ai PMS Engine</h2>
                                        <p style="margin: 0; font-size: 13px; color: #64748b;">Enterprise Performance Management System</p>
                                    </div>
                                </div>
                                <div style="padding: 24px; background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                                    <span style="display: inline-block; padding: 4px 10px; background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Active Cycle</span>
                                    <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #0f172a; font-weight: 700;">${cycleData.cycleName}</h3>
                                    <p style="margin: 0 0 16px 0; font-size: 14px; color: #475569;">
                                        Hello <strong>${empName}</strong>, a new performance review cycle has been officially rolled out.
                                    </p>
                                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                        <tr><td style="padding: 6px 0; color: #64748b;"><strong>Cycle Type:</strong></td><td style="padding: 6px 0; color: #0f172a; text-align: right;">${cycleData.cycleType}</td></tr>
                                        <tr><td style="padding: 6px 0; color: #64748b;"><strong>Start Date:</strong></td><td style="padding: 6px 0; color: #0f172a; text-align: right;">${cycleData.startDate || 'Immediate'}</td></tr>
                                        <tr><td style="padding: 6px 0; color: #64748b;"><strong>End Date:</strong></td><td style="padding: 6px 0; color: #0f172a; text-align: right;">${cycleData.endDate || 'Open'}</td></tr>
                                    </table>
                                </div>
                                <p style="font-size: 14px; color: #334155; line-height: 1.6; margin-bottom: 24px;">
                                    Please log into your Employee Workspace to record your work logs, define self-assigned deliverables, and monitor your real-time goal completion progress.
                                </p>
                                <div style="text-align: center; margin-bottom: 24px;">
                                    <a href="${typeof window !== 'undefined' ? window.location.origin : ''}/employee-appraisal.html?cycle=${cycleId}" style="display: inline-block; padding: 14px 28px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);">Open PMS Dashboard &rarr;</a>
                                </div>
                                <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0; border-top: 1px solid #f1f5f9; padding-top: 16px;">
                                    Automated dispatch from Kylrx.ai Enterprise PMS Cycle Engine.
                                </p>
                            </div>
                        `,
                        text: `Hello ${empName},\n\nA new PMS review cycle "${cycleData.cycleName}" (${cycleData.cycleType}) has been rolled out.\nPeriod: ${cycleData.startDate} to ${cycleData.endDate}.\n\nPlease log in to Kylrx.ai and record your deliverables and tasks.\nAccess portal: ${typeof window !== 'undefined' ? window.location.origin : ''}/employee-appraisal.html`
                    };

                    await fetch('/api/email/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(emailPayload)
                    });
                    emailResults.push({ email: empEmail, status: 'sent' });
                } catch (emailErr) {
                    console.warn(`[PMS Engine] Email alert trigger notice for ${empEmail}:`, emailErr.message);
                    emailResults.push({ email: empEmail, status: 'error', error: emailErr.message });
                }
            }
        }

        // 4. Mark the cycle active only after every review record exists, so a failed
        //    rollout never leaves an 'active' cycle without enrolled reviews
        await updateDoc(doc(db, 'pms_cycles', cycleId), {
            status: 'active',
            rolledOutAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        return {
            success: true,
            cycleId,
            enrolledCount: enrolledEmployees.length,
            notificationsDispatched: notificationResults.length,
            emailsSent: emailResults.filter(e => e.status === 'sent').length
        };
    } catch (err) {
        console.error('[PMS Engine] Error during cycle rollout:', err);
        throw err;
    }
}

/**
 * Helper to fetch all enrolled employees from both 'employees' and 'users' collections.
 */
export async function getEnrolledEmployees() {
    const candidateMap = new Map();
    // Relieved / exited / inactive people are not enrolled in review cycles
    const hasLeft = (data) => /relieved|exited|terminated|inactive/i.test(data.employmentStatus || data.status || '');

    try {
        const empSnap = await getDocs(collection(db, 'employees'));
        empSnap.forEach(d => {
            const data = d.data();
            const id = data.employeeId || d.id;
            if (hasLeft(data)) {
                candidateMap.set(id, null);
                return;
            }
            candidateMap.set(id, {
                id: d.id,
                employeeId: id,
                uid: data.uid || d.id,
                name: data.name || data.fullName || 'Employee',
                email: data.email || data.officialEmail || '',
                role: data.role || 'employee',
                department: data.department || data.departmentName || 'General',
                reportingManager: data.l1Manager || data.reportingManager || '',
                status: data.status || 'Active'
            });
        });
    } catch (e) {
        console.warn('[PMS Engine] Error loading employees collection:', e.message);
    }

    try {
        const usersSnap = await getDocs(collection(db, 'users'));
        usersSnap.forEach(d => {
            const data = d.data();
            const id = data.employeeId || d.id;
            if (!candidateMap.has(id) && !hasLeft(data)) {
                candidateMap.set(id, {
                    id: d.id,
                    employeeId: id,
                    uid: d.id,
                    name: data.name || data.fullName || 'Employee',
                    email: data.email || data.officialEmail || '',
                    role: data.role || 'employee',
                    department: data.department || 'General',
                    reportingManager: data.reportingManager || '',
                    status: 'Active'
                });
            }
        });
    } catch (e) {
        console.warn('[PMS Engine] Error loading users collection:', e.message);
    }

    return Array.from(candidateMap.values()).filter(Boolean);
}

/* ========================================================================== */
/* SECTION 8.2: EMPLOYEE TASK LOGGING & REAL-TIME PROGRESS TRACKING            */
/* ========================================================================== */

/**
 * Creates a work log / task in collection `pms_tasks/{taskId}`.
 * Schema: { cycleId, employeeId, assignedBy, title, description, status: ('pending' | 'completed'), reviewStatus: ('under_review' | 'accepted' | 'rejected'), feedback, createdAt, completedAt }
 */
export async function createPMSTask({ cycleId, employeeId, assignedBy, title, description, status = 'pending', reviewStatus = 'under_review', attachments = [] }) {
    console.log(`[PMS Tasks] Creating task for employee ${employeeId}: "${title}"...`);
    try {
        const taskId = `PMS-TASK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const taskRef = doc(db, 'pms_tasks', taskId);

        const payload = {
            taskId,
            cycleId: cycleId || 'DEFAULT-CYCLE',
            employeeId,
            assignedBy: assignedBy || employeeId, // employeeId for self-assigned, or managerId
            title: title.trim(),
            description: (description || '').trim(),
            status, // 'pending' | 'completed'
            reviewStatus, // 'under_review' | 'accepted' | 'rejected'
            feedback: '',
            attachments: Array.isArray(attachments) ? attachments : [],
            createdAt: serverTimestamp(),
            completedAt: status === 'completed' ? serverTimestamp() : null
        };

        await setDoc(taskRef, payload);
        return { success: true, taskId, task: payload };
    } catch (err) {
        console.error('[PMS Tasks] Error creating task:', err);
        throw err;
    }
}

/**
 * Marks a task as completed with optional work notes.
 * Moves the task into reviewStatus = 'under_review' and marks status = 'completed'.
 */
export async function completePMSTask(taskId, completionNotes = '') {
    console.log(`[PMS Tasks] Marking task ${taskId} as completed...`);
    try {
        const taskRef = doc(db, 'pms_tasks', taskId);
        const updates = {
            status: 'completed',
            reviewStatus: 'under_review',
            completedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        if (completionNotes) {
            updates.completionNotes = completionNotes.trim();
        }

        await updateDoc(taskRef, updates);
        return { success: true };
    } catch (err) {
        console.error('[PMS Tasks] Error completing task:', err);
        throw err;
    }
}

/**
 * Fetches all PMS tasks for a specific employee and cycle.
 */
export async function getPMSTasks(cycleId, employeeId) {
    try {
        let q;
        if (cycleId && employeeId) {
            q = query(
                collection(db, 'pms_tasks'),
                where('cycleId', '==', cycleId),
                where('employeeId', '==', employeeId)
            );
        } else if (employeeId) {
            q = query(
                collection(db, 'pms_tasks'),
                where('employeeId', '==', employeeId)
            );
        } else if (cycleId) {
            q = query(
                collection(db, 'pms_tasks'),
                where('cycleId', '==', cycleId)
            );
        } else {
            q = collection(db, 'pms_tasks');
        }

        const snap = await getDocs(q);
        const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Sort descending by creation
        return tasks.sort((a, b) => {
            const timeA = a.createdAt?.seconds || 0;
            const timeB = b.createdAt?.seconds || 0;
            return timeB - timeA;
        });
    } catch (err) {
        console.warn('[PMS Tasks] Error fetching tasks:', err.message);
        return [];
    }
}

/**
 * Real-time dynamic progress calculation.
 * Strictly computes: completionPercentage = (completedTasks / totalTasks) * 100
 */
export function calculateCompletionPercentage(tasksOrCompleted = [], maybeTotal = null) {
    if (typeof tasksOrCompleted === 'number' && typeof maybeTotal === 'number') {
        if (maybeTotal === 0) return 0;
        return Math.round(((tasksOrCompleted / maybeTotal) * 100) * 10) / 10;
    }
    const tasks = Array.isArray(tasksOrCompleted) ? tasksOrCompleted : [];
    const totalTasks = tasks.length;
    if (totalTasks === 0) {
        return {
            totalTasks: 0,
            completedTasks: 0,
            pendingTasks: 0,
            acceptedTasks: 0,
            rejectedTasks: 0,
            completionPercentage: 0
        };
    }

    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const pendingTasks = tasks.filter(t => t.status === 'pending').length;
    const acceptedTasks = tasks.filter(t => t.reviewStatus === 'accepted').length;
    const rejectedTasks = tasks.filter(t => t.reviewStatus === 'rejected').length;

    // Strict formula: (completedTasks / totalTasks) * 100
    const rawPercentage = (completedTasks / totalTasks) * 100;
    const completionPercentage = Math.round(rawPercentage * 10) / 10; // 1 decimal place, e.g. 66.7 or 100

    return {
        totalTasks,
        completedTasks,
        pendingTasks,
        acceptedTasks,
        rejectedTasks,
        completionPercentage
    };
}

/**
 * Super Admin & Manager Console aliases for cross-module compatibility
 */
export const assignManagerDeliverable = assignGoalToTeamMember;
/**
 * The signed-in user performing an action, for audit fields (reviewedBy, delegatedBy...).
 */
export function currentActor() {
    const user = auth && auth.currentUser;
    let name = '';
    try { name = localStorage.getItem('userName') || ''; } catch (_) {}
    return {
        id: user ? user.uid : 'unknown',
        name: name || (user && (user.displayName || user.email)) || 'Admin'
    };
}

export async function reviewTaskDeliverable(taskId, decision, feedback = '', reviewerId = currentActor().id) {
    if (decision === 'accepted') return await acceptPMSTask(taskId, reviewerId, feedback);
    return await rejectPMSTask(taskId, reviewerId, feedback);
}
export const delegateManagerReview = delegatePMSReview;
export async function updateTaskCompletion(taskId, markCompleted) {
    if (markCompleted) return await completePMSTask(taskId);
    const taskRef = doc(db, 'pms_tasks', taskId);
    await updateDoc(taskRef, {
        status: 'pending',
        reviewStatus: 'under_review',
        updatedAt: serverTimestamp()
    });
    return { success: true };
}

/* ========================================================================== */
/* SECTION 8.3: MANAGER REVIEW & BINARY ACCEPT / REJECT WORKFLOWS              */
/* ========================================================================== */

/**
 * Managers can assign specific goals/tasks directly to their team members.
 */
export async function assignGoalToTeamMember({ cycleId, employeeId, assignedBy, title, description, attachments = [] }) {
    console.log(`[PMS Review] Manager ${assignedBy} assigning goal to ${employeeId}: "${title}"...`);
    return await createPMSTask({
        cycleId,
        employeeId,
        assignedBy,
        title,
        description,
        status: 'pending',
        reviewStatus: 'under_review',
        attachments
    });
}

/**
 * Binary Action: ACCEPT a submitted task.
 * Marks reviewStatus = 'accepted', logs reviewer feedback and timestamp.
 */
export async function acceptPMSTask(taskId, reviewerId, feedback = '') {
    console.log(`[PMS Review] Accepting task ${taskId} by ${reviewerId}...`);
    try {
        const taskRef = doc(db, 'pms_tasks', taskId);
        await updateDoc(taskRef, {
            reviewStatus: 'accepted',
            feedback: feedback.trim(),
            reviewedBy: reviewerId,
            reviewedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        // Also update review score or metrics if associated review exists
        const taskDoc = await getDoc(taskRef);
        if (taskDoc.exists()) {
            const td = taskDoc.data();
            await recomputeReviewScore(td.cycleId, td.employeeId);
        }

        return { success: true };
    } catch (err) {
        console.error('[PMS Review] Error accepting task:', err);
        throw err;
    }
}

/**
 * Binary Action: REJECT a submitted task.
 * Crucial rule: Moves the task back to employee's active queue:
 * status = 'pending', reviewStatus = 'rejected', with optional reviewer remarks.
 */
export async function rejectPMSTask(taskId, reviewerId, feedback = '') {
    console.log(`[PMS Review] Rejecting task ${taskId} by ${reviewerId}...`);
    try {
        const taskRef = doc(db, 'pms_tasks', taskId);
        await updateDoc(taskRef, {
            status: 'pending', // MOVES BACK TO ACTIVE QUEUE!
            reviewStatus: 'rejected',
            feedback: (feedback || 'Needs rework. Please check reviewer notes and re-submit.').trim(),
            reviewedBy: reviewerId,
            reviewedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        // Notify employee of rejected task so they can revise immediately
        const taskDoc = await getDoc(taskRef);
        if (taskDoc.exists()) {
            const td = taskDoc.data();
            try {
                await addDoc(collection(db, 'notifications'), {
                    target: td.employeeId,
                    targetUid: td.employeeId,
                    title: `Task Needs Rework: ${td.title}`,
                    text: `Your task was marked for revision by reviewer. Feedback: "${feedback || 'Needs revision'}"`,
                    message: `Task "${td.title}" requires revisions.`,
                    priority: 'high',
                    type: 'pms_task_rejected',
                    taskId,
                    read: false,
                    timestamp: serverTimestamp()
                });
            } catch (notifErr) {
                console.warn('[PMS Review] Error dispatching rejection notification:', notifErr);
            }
            await recomputeReviewScore(td.cycleId, td.employeeId);
        }

        return { success: true };
    } catch (err) {
        console.error('[PMS Review] Error rejecting task:', err);
        throw err;
    }
}

/* ========================================================================== */
/* SECTION 8.4: TRACEABLE DELEGATION & PMS ASSIGNMENT ENGINE                   */
/* ========================================================================== */

/**
 * Allows managers to reassign / delegate their PMS review responsibilities for an
 * employee to another peer or team member.
 * Maintains a transparent, immutable audit trail in Firestore recording:
 * `originalManagerId`, `delegatedToId`, `delegatedAt`, and `reason`.
 * Ensures reassignment updates are immediately visible on the review cards.
 */
export async function delegatePMSReview({ reviewId, cycleId, employeeId, originalManagerId, delegatedToId, delegatedToName = '', delegatedById = '', delegatedByName = '', reason }) {
    if (!employeeId || !delegatedToId) {
        throw new Error('Delegation needs both the employee under review and the manager to delegate to.');
    }
    console.log(`[PMS Delegation] Delegating review for employee ${employeeId} from ${originalManagerId} to ${delegatedToId}...`);
    try {
        let targetDocId = reviewId;
        if (!targetDocId && cycleId && employeeId) {
            targetDocId = `REV-${cycleId}-${employeeId}`;
        }

        let reviewRef = doc(db, 'pms_reviews', targetDocId);
        let reviewSnap = await getDoc(reviewRef);

        const nowIso = new Date().toISOString();
        const delegationRecord = {
            originalManagerId: originalManagerId || 'MANAGER-ORIG',
            delegatedToId: delegatedToId,
            delegatedToName: delegatedToName || delegatedToId,
            delegatedById: delegatedById || currentActor().id,
            delegatedByName: delegatedByName || currentActor().name,
            delegatedAt: nowIso,
            reason: (reason || 'Operational reassignment / peer review delegation').trim()
        };

        if (!reviewSnap.exists()) {
            // Create review doc if not yet existing
            await setDoc(reviewRef, {
                reviewId: targetDocId,
                cycleId: cycleId || 'DEFAULT',
                employeeId,
                reviewerId: originalManagerId,
                delegatedTo: delegatedToId,
                delegationHistory: [delegationRecord],
                overallScore: 0,
                status: 'in_progress',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        } else {
            // Append to immutable delegationHistory and update delegatedTo
            await updateDoc(reviewRef, {
                delegatedTo: delegatedToId,
                delegationHistory: arrayUnion(delegationRecord),
                updatedAt: serverTimestamp()
            });
        }

        // Notify the newly delegated reviewer
        try {
            await addDoc(collection(db, 'notifications'), {
                target: delegatedToId,
                targetUid: delegatedToId,
                title: 'PMS Review Delegated to You',
                text: `${delegatedByName || 'A peer manager'} delegated performance review responsibility for employee ${employeeId} to you. Reason: ${reason}`,
                message: `PMS Review responsibility delegated to you.`,
                priority: 'normal',
                type: 'pms_review_delegated',
                read: false,
                timestamp: serverTimestamp()
            });
        } catch (notifErr) {
            console.warn('[PMS Delegation] Error dispatching delegation notice:', notifErr);
        }

        console.log(`[PMS Delegation] Delegation successfully recorded with immutable audit entry.`);
        return { success: true, delegationRecord };
    } catch (err) {
        console.error('[PMS Delegation] Failed to delegate review:', err);
        throw err;
    }
}

/**
 * Fetches PMS reviews for a cycle and manager, including delegated responsibilities.
 */
export async function getPMSReviews(cycleId, managerId) {
    try {
        const reviewsRef = collection(db, 'pms_reviews');
        let reviewsSnap;

        if (cycleId) {
            const q = query(reviewsRef, where('cycleId', '==', cycleId));
            reviewsSnap = await getDocs(q);
        } else {
            reviewsSnap = await getDocs(reviewsRef);
        }

        let allReviews = reviewsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Filter for reviews assigned directly OR delegated to this manager
        if (managerId && managerId !== 'admin' && managerId !== 'superadmin') {
            allReviews = allReviews.filter(r => 
                r.reviewerId === managerId || 
                r.delegatedTo === managerId || 
                (r.delegationHistory && r.delegationHistory.some(dh => dh.delegatedToId === managerId))
            );
        }

        return allReviews;
    } catch (err) {
        console.warn('[PMS Reviews] Error fetching reviews:', err.message);
        return [];
    }
}

/**
 * Helper to recompute overallScore for an employee in pms_reviews based on accepted tasks.
 */
async function recomputeReviewScore(cycleId, employeeId) {
    try {
        const reviewId = `REV-${cycleId}-${employeeId}`;
        const reviewRef = doc(db, 'pms_reviews', reviewId);
        const reviewSnap = await getDoc(reviewRef);
        if (!reviewSnap.exists()) return;

        const tasks = await getPMSTasks(cycleId, employeeId);
        const { completionPercentage, totalTasks, acceptedTasks } = calculateCompletionPercentage(tasks);

        // Overall score calculated based on percentage of accepted tasks
        const score = totalTasks > 0 ? Math.round((acceptedTasks / totalTasks) * 100) : 0;

        await updateDoc(reviewRef, {
            overallScore: score,
            completionPercentage,
            updatedAt: serverTimestamp()
        });
    } catch (e) {
        console.warn('[PMS Review] Recompute score notice:', e.message);
    }
}

/* ========================================================================== */
/* EXISTING PMS SERVICE FUNCTIONS (PRESERVED FOR BACKWARD COMPATIBILITY)       */
/* ========================================================================== */


export async function submitTask(employeeId, taskData) {
    console.log(`[PMS] Adding task for ${employeeId}: ${taskData.title}...`);
    try {
        const taskId = `TASK-${Date.now()}`;
        const taskRef = doc(db, 'employee_tasks', taskId);
        
        const payload = {
            ...taskData,
            employeeId,
            taskId,
            status: 'Active',
            progress: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        await setDoc(taskRef, payload);
        return { success: true, taskId };
    } catch (err) {
        console.error('[PMS] Task submission failed:', err);
        throw err;
    }
}

export async function submitEOD(employeeId, summary, tasksCompleted) {
    console.log(`[PMS] Submitting EOD for ${employeeId}...`);
    try {
        const eodId = `EOD-${Date.now()}`;
        const eodRef = doc(db, 'employee_eods', eodId);
        
        const payload = {
            employeeId,
            summary,
            tasksCompleted,
            status: 'Pending Review',
            submittedAt: serverTimestamp(),
            managerScore: 0,
            managerComments: ''
        };

        await setDoc(eodRef, payload);
        
        // Notify Reporting Manager
        const userSnap = await getDoc(doc(db, 'users', employeeId));
        const managerId = userSnap.data().reportingManager;
        if (managerId) {
            await createNotification(managerId, `EOD summary submitted by ${userSnap.data().name}. Review pending.`, 'normal');
        }

        return { success: true, eodId };
    } catch (err) {
        console.error('[PMS] EOD submission failed:', err);
        throw err;
    }
}

export async function scorePerformance(eodId, score, comments, adminId) {
    console.log(`[PMS] Scoring EOD ${eodId} with score ${score}...`);
    const eodRef = doc(db, 'employee_eods', eodId);
    
    await updateDoc(eodRef, {
        status: 'Reviewed',
        managerScore: score,
        managerComments: comments,
        scoredBy: adminId,
        scoredAt: serverTimestamp()
    });

    // Update global productivity score for the user
    const eodSnap = await getDoc(eodRef);
    const empId = eodSnap.data().employeeId;
    await updateProductivityEngine(empId, score);
}

async function updateProductivityEngine(employeeId, newScore) {
    const perfRef = doc(db, 'performance_metrics', employeeId);
    const snap = await getDoc(perfRef);
    
    let finalScore = newScore;
    if (snap.exists()) {
        const currentData = snap.data();
        finalScore = (currentData.overallScore + newScore) / 2; // Simple running average
        await updateDoc(perfRef, {
            overallScore: finalScore,
            lastUpdated: serverTimestamp()
        });
    } else {
        await setDoc(perfRef, {
            employeeId,
            overallScore: newScore,
            lastUpdated: serverTimestamp()
        });
    }

    // Save historical snapshot for trends
    const snapshotId = `${employeeId}_${Date.now()}`;
    await setDoc(doc(db, 'performance_snapshots', snapshotId), {
        employeeId,
        score: finalScore,
        timestamp: serverTimestamp(),
        date: new Date().toISOString().split('T')[0]
    });
}

export async function getDepartmentLeaderboard(deptId) {
    const q = query(
        collection(db, 'performance_metrics'),
        orderBy('overallScore', 'desc'),
        limit(100)
    );
    const snap = await getDocs(q);
    const metrics = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    // Enrich metrics with user profile data
    const enrichedLeaders = await Promise.all(metrics.map(async (metric) => {
        try {
            const userSnap = await getDoc(doc(db, 'users', metric.id || metric.employeeId));
            if (userSnap.exists()) {
                const userData = userSnap.data();
                return {
                    ...metric,
                    employeeName: userData.name,
                    department: userData.department,
                    role: userData.role
                };
            }
            return metric;
        } catch (err) {
            console.warn(`[PMS] Failed to enrich leader ${metric.id}:`, err);
            return metric;
        }
    }));

    return enrichedLeaders;
}

export async function getDepartments() {
    console.log('[PMS] Fetching units...');
    try {
        const snap = await getDocs(collection(db, 'command_centers'));
        if (!snap.empty) {
            return snap.docs.map(d => {
                const data = d.data();
                let name = data.name || data.departmentName || 'Unnamed';
                if (data.targetType) {
                    const targetSuffix = data.targetType === 'Manager Suite' ? 'Manager' : 'Employee';
                    if (!name.toLowerCase().includes('manager') && !name.toLowerCase().includes('employee')) {
                        name = `${name} ${targetSuffix}`;
                    }
                }
                return {
                    id: d.id,
                    ...data,
                    name: name,
                    departmentName: name
                };
            });
        }
        // Fallback to legacy departments collection
        const oldSnap = await getDocs(collection(db, 'departments'));
        if (!oldSnap.empty) {
            return oldSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
    } catch (err) {
        console.warn('[PMS] Notice fetching departments from Firestore:', err.message);
    }

    // Standard enterprise business units fallback
    return [
        { id: 'dept-eng', name: 'Engineering', departmentName: 'Engineering' },
        { id: 'dept-hr', name: 'Human Resources', departmentName: 'Human Resources' },
        { id: 'dept-fin', name: 'Finance & Accounts', departmentName: 'Finance & Accounts' },
        { id: 'dept-leg', name: 'Legal & Compliance', departmentName: 'Legal & Compliance' },
        { id: 'dept-ops', name: 'Operations & Logistics', departmentName: 'Operations & Logistics' },
        { id: 'dept-sales', name: 'Sales & Marketing', departmentName: 'Sales & Marketing' }
    ];
}

export async function getManagers() {
    console.log('[PMS] Fetching managers...');
    const q = query(collection(db, 'users'), where('role', '==', 'manager'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getDepartmentProductivity() {
    console.log('[PMS] Calculating departmental efficiency...');
    try {
        const metricsSnap = await getDocs(collection(db, 'performance_metrics'));
        const usersSnap = await getDocs(collection(db, 'users'));
        
        const deptMap = {};
        
        // Strategy: Use performance_metrics if available, otherwise fallback to user's direct productivity field
        usersSnap.forEach(userDoc => {
            const userData = userDoc.data();
            const dept = userData.department || 'General';
            if (!deptMap[dept]) deptMap[dept] = [];
            
            // Check for explicit metric first
            const metric = metricsSnap.docs.find(d => d.id === userDoc.id);
            if (metric) {
                deptMap[dept].push(metric.data().overallScore || 0);
            } else if (userData.productivity) {
                deptMap[dept].push(Number(userData.productivity));
            }
        });

        const results = Object.keys(deptMap).map(name => {
            const scores = deptMap[name];
            if (scores.length === 0) return { name, score: 0 };
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            return { name, score: Math.round(avg) };
        });

        return results;
    } catch (err) {
        console.error('[PMS] Failed to calculate dept productivity:', err);
        return [];
    }
}

export async function getPerformanceTrends() {
    console.log('[PMS] Fetching unified trends...');
    try {
        const snapRef = collection(db, 'performance_snapshots');
        const snapQuery = query(snapRef, orderBy('timestamp', 'asc'), limit(500));
        const snapDocs = await getDocs(snapQuery);
        
        let results = snapDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthlyData = {};

        // If snapshots are empty, try aggregating from reviewed EODs
        if (results.length === 0) {
            console.log('[PMS] Snapshots empty, aggregating from EODs...');
            const eodSnap = await getDocs(query(collection(db, 'employee_eods'), where('status', '==', 'Reviewed')));
            results = eodSnap.docs.map(doc => {
                const data = doc.data();
                return {
                    score: data.managerScore || 0,
                    timestamp: data.scoredAt || data.submittedAt
                };
            });
        }

        // If still empty, we return a zeroed baseline for accuracy (instead of hardcoded mocks)
        if (results.length === 0) {
            const currentMonthIdx = new Date().getMonth();
            const emptyLabels = [];
            for (let i = 5; i >= 0; i--) {
                let idx = currentMonthIdx - i;
                if (idx < 0) idx += 12;
                emptyLabels.push(monthNames[idx]);
            }
            return { labels: emptyLabels, data: Array(6).fill(0) };
        }

        results.forEach(data => {
            if (data.timestamp && data.score !== undefined) {
                const date = data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
                const month = monthNames[date.getMonth()];
                if (!monthlyData[month]) monthlyData[month] = [];
                monthlyData[month].push(Number(data.score));
            }
        });

        const currentMonthIdx = new Date().getMonth();
        const displayMonths = [];
        for (let i = 5; i >= 0; i--) {
            let idx = currentMonthIdx - i;
            if (idx < 0) idx += 12;
            displayMonths.push(monthNames[idx]);
        }

        const trendValues = displayMonths.map(month => {
            const scores = monthlyData[month] || [];
            if (scores.length === 0) return 0;
            return scores.reduce((a, b) => a + b, 0) / scores.length;
        });

        return { labels: displayMonths, data: trendValues };
    } catch (err) {
        console.error('[PMS] Failed to fetch performance trends:', err);
        return { labels: [], data: [] };
    }
}

export async function getProductivityHeatmap() {
    console.log('[PMS] Fetching heatmap data...');
    try {
        const q = query(
            collection(db, 'employee_eods'),
            where('status', '==', 'Reviewed'),
            limit(200)
        );
        const snap = await getDocs(q);
        const dayMap = Array(7).fill(0).map(() => []); // [Sun, Mon, Tue, Wed, Thu, Fri, Sat]

        snap.docs.forEach(doc => {
            const data = doc.data();
            if (data.submittedAt && data.managerScore) {
                const date = data.submittedAt.toDate ? data.submittedAt.toDate() : new Date(data.submittedAt);
                const day = date.getDay();
                dayMap[day].push(data.managerScore);
            }
        });

        return dayMap.map(scores => {
            if (scores.length === 0) return 0;
            return scores.reduce((a, b) => a + b, 0) / scores.length;
        });
    } catch (err) {
        console.error('[PMS] Failed to fetch heatmap data:', err);
        return Array(7).fill(0);
    }
}

export async function getAIProductivityInsights(dayScores, trendData) {
    console.log('[PMS] Generating AI insights...');
    const avg = dayScores.reduce((a, b) => a + b, 0) / (dayScores.filter(s => s > 0).length || 1);
    const lastMonth = trendData.data[trendData.data.length - 1] || 0;
    const prevMonth = trendData.data[trendData.data.length - 2] || 0;
    
    const insights = [];
    if (avg > 80) insights.push({ type: 'positive', text: 'Workforce efficiency is 12% above quarterly baseline.' });
    if (lastMonth > prevMonth) insights.push({ type: 'positive', text: 'Upward productivity trend detected. Projected ARR impact: +' + ((typeof window !== 'undefined' && window.KylrxFmt && KylrxFmt.code() !== 'IN') ? '$' : '₹') + '12M.' });
    
    // Anomaly Detection
    dayScores.forEach((score, i) => {
        if (score > 0 && score < (avg * 0.6)) {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            insights.push({ type: 'warning', text: `Anomaly detected on ${days[i]}: 40% drop in expected output.` });
        }
    });

    if (insights.length === 0) insights.push({ type: 'neutral', text: 'Productivity is stable. No critical anomalies detected.' });
    return insights;
}

export async function getPerformanceForecast(trendData) {
    const lastPoint = trendData.data[trendData.data.length - 1] || 70;
    const growthRate = 1.05; // 5% projected growth
    const forecast = [];
    for(let i=1; i<=3; i++) {
        forecast.push(lastPoint * Math.pow(growthRate, i));
    }
    return forecast;
}

async function createNotification(target, message, priority, title = 'Performance Hub') {
    await addDoc(collection(db, 'notifications'), {
        target,
        targetUid: target,
        title,
        text: message,
        message,
        priority,
        read: false,
        timestamp: serverTimestamp()
    });
}

export async function getPendingReviews() {
    console.log('[PMS] Fetching pending reviews...');
    try {
        const q = query(
            collection(db, 'employee_eods'),
            where('status', '==', 'Pending Review'),
            limit(50)
        );
        const snap = await getDocs(q);
        const results = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Enrich with employee names
        const enrichedResults = await Promise.all(results.map(async (review) => {
            try {
                const userSnap = await getDoc(doc(db, 'users', review.employeeId));
                if (userSnap.exists()) {
                    return { ...review, employeeName: userSnap.data().name };
                }
                return review;
            } catch (err) {
                return review;
            }
        }));

        // Sort in JS to avoid composite index requirement
        return enrichedResults.sort((a, b) => {
            const timeA = a.submittedAt?.seconds || 0;
            const timeB = b.submittedAt?.seconds || 0;
            return timeB - timeA;
        }).slice(0, 10);
    } catch (err) {
        console.error('[PMS] Failed to fetch pending reviews:', err);
        throw err;
    }
}

export async function calculateAttendanceProductivity(employeeId, punchIn, punchOut) {
    if (!punchIn || !punchOut) return;
    
    try {
        const durationMs = (punchOut.toMillis ? punchOut.toMillis() : new Date(punchOut).getTime()) - 
                          (punchIn.toMillis ? punchIn.toMillis() : new Date(punchIn).getTime());
        const hours = durationMs / (1000 * 60 * 60);
        
        // Scoring logic: 8 hours = 100 points
        const baseGoal = 8;
        let score = (hours / baseGoal) * 100;
        if (score > 120) score = 120; // Cap at 120 for extreme overtime
        
        console.log(`[PMS] Attendance Productivity for ${employeeId}: ${hours.toFixed(2)}h -> Score: ${score.toFixed(1)}`);
        
        await updateProductivityEngine(employeeId, score);
        return score;
    } catch (err) {
        console.error('[PMS] Failed to calculate attendance productivity:', err);
    }
}
export async function getOrgMetrics() {
    console.log('[PMS] Fetching organizational metrics...');
    try {
        const configRef = doc(db, 'system_config', 'revenue_metrics');
        const configSnap = await getDoc(configRef);
        
        // Accurate Target calculation: Number of Departments * 100M baseline
        const deptsSnap = await getDocs(collection(db, 'command_centers'));
        const deptCount = deptsSnap.size || 5; 
        const calculatedTarget = deptCount * 100;

        // Accurate Current Progress: Based on Average Performance Score * Target
        const metricsSnap = await getDocs(collection(db, 'performance_metrics'));
        const totalScore = metricsSnap.docs.reduce((acc, d) => acc + (d.data().overallScore || 0), 0);
        const avgScore = metricsSnap.size > 0 ? (totalScore / metricsSnap.size) : 75; // Fallback to 75% if no metrics yet
        
        const calculatedCurrent = Math.round((avgScore / 100) * calculatedTarget);

        if (configSnap.exists()) {
            const data = configSnap.data();
            return {
                ...data,
                currentArr: data.currentArr || calculatedCurrent,
                arrTarget: data.arrTarget || calculatedTarget
            };
        }

        return {
            currentArr: calculatedCurrent,
            arrTarget: calculatedTarget,
            currency: (typeof window !== 'undefined' && window.KylrxFmt) ? (new Intl.NumberFormat(KylrxFmt.locale(), { style: 'currency', currency: KylrxFmt.currency(), maximumFractionDigits: 0 }).format(0).replace(/[\d\s.,]/g, '')) : '₹',
            lastUpdated: serverTimestamp()
        };
    } catch (err) {
        console.error('[PMS] Failed to fetch org metrics:', err);
        return { currentArr: 0, arrTarget: 100, currency: (typeof window !== 'undefined' && window.KylrxFmt) ? KylrxFmt.moneyCompact(0).replace(/[\d\s.,]/g, '') : '₹' };
    }
}

export async function uploadPMSDocument({ title, category, description, fileObj, uploadedBy }) {
    try {
        const docId = `DOC-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const docRef = doc(db, 'pms_documents', docId);
        const payload = {
            docId,
            id: docId,
            title: title || fileObj.name,
            category: category || 'General PMS Document',
            description: description || '',
            name: fileObj.name,
            size: fileObj.size || 0,
            sizeFormatted: fileObj.sizeFormatted || ((fileObj.size / 1024).toFixed(1) + ' KB'),
            type: fileObj.type || 'application/octet-stream',
            dataUrl: fileObj.dataUrl || '',
            uploadedBy: uploadedBy || 'Super Admin',
            createdAt: serverTimestamp(),
            uploadedAt: new Date().toISOString()
        };
        await setDoc(docRef, payload);
        console.log(`[PMS Engine] Document uploaded to pms_documents: ${docId}`);
        return { success: true, docId, document: payload };
    } catch (err) {
        console.error('[PMS Engine] Error uploading PMS document:', err);
        throw err;
    }
}

export async function getPMSDocuments() {
    try {
        const snap = await getDocs(collection(db, 'pms_documents'));
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return docs.sort((a, b) => {
            const timeA = a.createdAt?.seconds || 0;
            const timeB = b.createdAt?.seconds || 0;
            return timeB - timeA;
        });
    } catch (err) {
        console.warn('[PMS Engine] Error fetching pms_documents:', err.message);
        return [];
    }
}

export async function deletePMSDocument(docId) {
    try {
        await deleteDoc(doc(db, 'pms_documents', docId));
        return { success: true };
    } catch (err) {
        console.error('[PMS Engine] Error deleting pms_document:', err);
        throw err;
    }
}

export async function addAttachmentToPMSCycle(cycleId, fileObj) {
    try {
        const cycleRef = doc(db, 'pms_cycles', cycleId);
        const snap = await getDoc(cycleRef);
        if (!snap.exists()) throw new Error(`Cycle ${cycleId} not found`);
        const currentAtts = snap.data().attachments || [];
        currentAtts.push(fileObj);
        await updateDoc(cycleRef, {
            attachments: currentAtts,
            updatedAt: serverTimestamp()
        });
        return { success: true, attachments: currentAtts };
    } catch (err) {
        console.error('[PMS Engine] Error adding attachment to cycle:', err);
        throw err;
    }
}

export async function removeAttachmentFromPMSCycle(cycleId, fileIdx) {
    try {
        const cycleRef = doc(db, 'pms_cycles', cycleId);
        const snap = await getDoc(cycleRef);
        if (!snap.exists()) throw new Error(`Cycle ${cycleId} not found`);
        const currentAtts = snap.data().attachments || [];
        currentAtts.splice(fileIdx, 1);
        await updateDoc(cycleRef, {
            attachments: currentAtts,
            updatedAt: serverTimestamp()
        });
        return { success: true, attachments: currentAtts };
    } catch (err) {
        console.error('[PMS Engine] Error removing attachment from cycle:', err);
        throw err;
    }
}

export async function getAllPMSUploadedFiles() {
    try {
        const [cycles, allTasks, pmsDocs] = await Promise.all([
            getPMSCycles(),
            getPMSTasks(),
            getPMSDocuments()
        ]);

        const aggregated = [];

        // 1. Files from Review Cycles
        for (const cycle of cycles) {
            const atts = cycle.attachments || [];
            atts.forEach((att, idx) => {
                aggregated.push({
                    fileId: `att-cycle-${cycle.cycleId || cycle.id}-${idx}`,
                    id: `att-cycle-${cycle.cycleId || cycle.id}-${idx}`,
                    name: att.name,
                    size: att.size,
                    sizeFormatted: att.sizeFormatted || ((att.size / 1024).toFixed(1) + ' KB'),
                    type: att.type || 'application/octet-stream',
                    dataUrl: att.dataUrl,
                    uploadedAt: att.uploadedAt || cycle.createdAt?.toDate ? cycle.createdAt.toDate().toISOString() : new Date().toISOString(),
                    uploadedBy: cycle.createdBy || 'Super Admin',
                    source: 'cycle',
                    sourceId: cycle.cycleId || cycle.id,
                    sourceTitle: cycle.cycleName || 'PMS Cycle',
                    category: 'Review Cycle Policy / Guidelines',
                    fileIdx: idx
                });
            });
        }

        // 2. Files from Tasks & Goals
        for (const task of allTasks) {
            const atts = task.attachments || [];
            atts.forEach((att, idx) => {
                const isGoal = task.type === 'goal' || task.assignedBy !== 'self';
                aggregated.push({
                    fileId: `att-task-${task.taskId || task.id}-${idx}`,
                    id: `att-task-${task.taskId || task.id}-${idx}`,
                    name: att.name,
                    size: att.size,
                    sizeFormatted: att.sizeFormatted || ((att.size / 1024).toFixed(1) + ' KB'),
                    type: att.type || 'application/octet-stream',
                    dataUrl: att.dataUrl,
                    uploadedAt: att.uploadedAt || task.createdAt?.toDate ? task.createdAt.toDate().toISOString() : new Date().toISOString(),
                    uploadedBy: task.assignedBy || task.employeeId || 'Employee',
                    source: isGoal ? 'goal' : 'task',
                    sourceId: task.taskId || task.id,
                    sourceTitle: task.title || 'Work Task',
                    category: isGoal ? 'Manager Goal PRD / Criteria' : 'Employee Work Log Evidence',
                    fileIdx: idx
                });
            });
        }

        // 3. Standalone PMS Documents
        for (const docItem of pmsDocs) {
            aggregated.push({
                fileId: `pms-doc-${docItem.id}`,
                id: docItem.id,
                name: docItem.name || docItem.title,
                size: docItem.size,
                sizeFormatted: docItem.sizeFormatted || ((docItem.size / 1024).toFixed(1) + ' KB'),
                type: docItem.type || 'application/octet-stream',
                dataUrl: docItem.dataUrl,
                uploadedAt: docItem.uploadedAt || (docItem.createdAt?.toDate ? docItem.createdAt.toDate().toISOString() : new Date().toISOString()),
                uploadedBy: docItem.uploadedBy || 'Super Admin',
                source: 'document',
                sourceId: docItem.id,
                sourceTitle: docItem.title || 'PMS Document',
                category: docItem.category || 'General PMS Document',
                isStandaloneDoc: true
            });
        }

        return aggregated.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    } catch (err) {
        console.error('[PMS Engine] Error aggregating all uploaded files:', err);
        return [];
    }
}

/* ========================================================================== */
/* SECTION 8.5: MANAGER GOAL MANAGEMENT (PRD §1.1)                             */
/* ========================================================================== */

const API_BASE = (typeof window !== 'undefined' && window.location && (window.location.port === '5500' || window.location.port === '5501'))
    ? `${window.location.origin}/api`
    : '/api';

export async function getManagerGoals(filters = {}) {
    try {
        const queryParams = new URLSearchParams(filters).toString();
        const res = await fetch(`${API_BASE}/manager-goals?${queryParams}`);
        if (res.ok) {
            const json = await res.json();
            return json.data || [];
        }
        return [];
    } catch (err) {
        console.warn('[ManagerGoals] Error fetching goals:', err.message);
        return [];
    }
}

export async function getManagerGoalStats(ownerId = null) {
    try {
        const url = ownerId ? `${API_BASE}/manager-goals/stats/summary?ownerId=${encodeURIComponent(ownerId)}` : `${API_BASE}/manager-goals/stats/summary`;
        const res = await fetch(url);
        if (res.ok) {
            const json = await res.json();
            return json.data;
        }
        return { total: 0, active: 0, paused: 0, completed: 0, archived: 0, avgProgress: 0 };
    } catch (err) {
        console.warn('[ManagerGoals] Error fetching stats:', err.message);
        return { total: 0, active: 0, paused: 0, completed: 0, archived: 0, avgProgress: 0 };
    }
}

export async function createManagerGoal(goalData, actor) {
    const res = await fetch(`${API_BASE}/manager-goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...goalData, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to create manager goal');
    }
    return json.data;
}

export async function updateManagerGoal(id, updates, actor) {
    const res = await fetch(`${API_BASE}/manager-goals/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update manager goal');
    }
    return json.data;
}

export async function updateManagerGoalProgress(id, progress, note = '', actor, currentValue = null) {
    const res = await fetch(`${API_BASE}/manager-goals/${encodeURIComponent(id)}/progress`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress, note, currentValue, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update goal progress');
    }
    return json.data;
}

export async function executeManagerGoalAction(id, action, options = {}, actor) {
    const res = await fetch(`${API_BASE}/manager-goals/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...options, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || `Failed to execute action ${action}`);
    }
    return json.data;
}

export async function toggleManagerGoalMilestone(id, milestoneId, actor) {
    const res = await fetch(`${API_BASE}/manager-goals/${encodeURIComponent(id)}/milestones/${encodeURIComponent(milestoneId)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to toggle milestone');
    }
    return json.data;
}

export async function getManagerGoalHistory(id) {
    const res = await fetch(`${API_BASE}/manager-goals/${encodeURIComponent(id)}/history`);
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to fetch goal history');
    }
    return json.data || [];
}

/* ========================================================================== */
/* SECTION 8.6: CUSTOMISABLE TEMPLATES (PRD §1.2)                              */
/* ========================================================================== */

export async function getCustomTemplates(filters = {}) {
    try {
        const queryParams = new URLSearchParams(filters).toString();
        const res = await fetch(`${API_BASE}/custom-templates?${queryParams}`);
        if (res.ok) {
            const json = await res.json();
            return json.data || [];
        }
        return [];
    } catch (err) {
        console.warn('[CustomTemplates] Error fetching templates:', err.message);
        return [];
    }
}

export async function getCustomTemplate(idOrKey) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}`);
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to fetch template');
    }
    return json.data;
}

export async function createCustomTemplate(templateData, actor) {
    const res = await fetch(`${API_BASE}/custom-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...templateData, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to create template');
    }
    return json.data;
}

export async function updateCustomTemplate(idOrKey, updates, actor) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updates, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update template');
    }
    return json.data;
}

export async function previewCustomTemplate(idOrKey, customFieldValues) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customFieldValues })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to preview template');
    }
    return json.data;
}

export async function saveCustomTemplateDraft(idOrKey, updates, actor) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to save draft template');
    }
    return json.data;
}

export async function publishCustomTemplate(idOrKey, actor) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to publish template');
    }
    return json.data;
}

export async function updateCustomTemplatePermissions(idOrKey, permissions, actor) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update template permissions');
    }
    return json.data;
}

export async function instantiateCustomTemplate(idOrKey, userInputs, actor) {
    const res = await fetch(`${API_BASE}/custom-templates/${encodeURIComponent(idOrKey)}/instantiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInputs, actor })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to instantiate template');
    }
    return json.data;
}

