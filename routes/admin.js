const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const { validateDepartment, validateEmployee } = require("../middleware/validator");
const { verifyToken, authorize } = require("../middleware/authMiddleware");

// Secure all admin routes
router.use(verifyToken);
router.use(authorize('Admin', 'Super Admin'));

router.post("/bank/transfer", adminController.transferBank);
router.post("/create-department", validateDepartment, adminController.createDepartment);
router.get("/departments", adminController.getAllDepartments);

// Employee & Manager Routes
router.post("/create-employee", validateEmployee, adminController.createEmployee);
router.post("/create-manager", validateEmployee, adminController.createManager);
router.get("/employees", adminController.getAllEmployees);
router.get("/analytics", adminController.getAnalytics);
router.post("/sync-database", adminController.syncDatabase);

// RESTFUL Aliases
router.post("/departments", validateDepartment, adminController.createDepartment);
router.post("/employees", validateEmployee, adminController.createEmployee);
router.post("/employees/:id/trigger-invite", adminController.triggerEmailInvite);
router.post("/job-roster/import", require("../services/job-roster-import").importJobRoster);
router.put("/employees/:id", adminController.updateEmployee);
router.delete("/employees/:id", adminController.deleteEmployee);
router.post("/managers", validateEmployee, adminController.createManager);

// PRD Section 1 & Section 10: Business Unit Schema, Rules & Management
router.get("/bu-rules", adminController.getBuRules);
router.post("/bu-rules", adminController.saveBuRule);
router.get("/business-units", adminController.getBuRules);
router.post("/business-units", adminController.saveBuRule);
router.put("/business-units/:code", adminController.updateBusinessUnit);
router.patch("/business-units/:code/toggle-status", adminController.toggleBusinessUnitStatus);
router.delete("/business-units/:code", adminController.deleteBusinessUnit);

// PRD Section 13: Employee Job Details & Official Documents
router.get("/employees/:id/profile", adminController.getEmployeeProfile);
router.get("/employees/:id", adminController.getEmployeeProfile);
router.put("/employees/:id/profile", adminController.updateEmployeeProfile);
router.post("/employees/:id/documents", adminController.uploadEmployeeDocument);
router.delete("/employees/:id/documents/:docId", adminController.deleteEmployeeDocument);

// PRD Section 14: Manual L1/L2 Manager Assignment & Org Chart
router.get("/employees/:id/managers", adminController.getEmployeeManagers);
router.put("/employees/:id/managers", adminController.updateEmployeeManagers);
router.get("/org-chart", adminController.getOrgChart);

// PRD Sections 1, 10, & 13: Cost Center Schema, Ingestion & Management
router.get("/cost-centers", adminController.getCostCenters);
router.post("/cost-centers", adminController.createCostCenter);
router.put("/cost-centers/:code", adminController.updateCostCenter);
router.patch("/cost-centers/:code/toggle-status", adminController.toggleCostCenterStatus);
router.delete("/cost-centers/:code", adminController.deleteCostCenter);
router.post("/cost-centers/bulk", adminController.bulkImportCostCenters);

// PRD Sections 1, 10, & 13: Sub-Department Schema, Parsing & Hierarchy
router.get("/sub-departments", adminController.getSubDepartments);
router.post("/sub-departments", adminController.createSubDepartment);
router.put("/sub-departments/:code", adminController.updateSubDepartment);
router.patch("/sub-departments/:code/toggle-status", adminController.toggleSubDepartmentStatus);
router.delete("/sub-departments/:code", adminController.deleteSubDepartment);
router.post("/sub-departments/bulk", adminController.bulkImportSubDepartments);
router.post("/departments/:code/propagate-sub-departments", adminController.propagateDepartmentHeadUpdate);

// PRD Sections 1, 13, & 16: Shifts & Week-offs Schema, Roster & Dynamic Attendance
router.get("/shifts", adminController.getShifts);
router.post("/shifts", adminController.createShift);
router.put("/shifts/:code", adminController.updateShift);
router.patch("/shifts/:code/toggle-status", adminController.toggleShiftStatus);
router.delete("/shifts/:code", adminController.deleteShift);
router.post("/shifts/bulk", adminController.bulkImportShifts);
router.post("/shifts/calculate-attendance", adminController.calculatePunchAttendance);

// PRD Sections 1, 15, & 16: Attendance Rules & Policies Schema, Evaluation & Geofence/IP Engine
router.get("/attendance-policies", adminController.getAttendancePolicies);
router.get("/attendance-policies/:code", adminController.getAttendancePolicyByCode);
router.post("/attendance-policies", adminController.createAttendancePolicy);
router.put("/attendance-policies/:code", adminController.updateAttendancePolicy);
router.patch("/attendance-policies/:code/toggle-status", adminController.toggleAttendancePolicyStatus);
router.delete("/attendance-policies/:code", adminController.deleteAttendancePolicy);
router.post("/attendance-policies/bulk", adminController.bulkImportAttendancePolicies);
router.post("/attendance-policies/evaluate-clock-in", adminController.evaluateClockIn);
router.post("/attendance-policies/validate-regularization", adminController.validateRegularization);
router.post("/attendance-policies/evaluate-overtime", adminController.evaluateOvertime);

module.exports = router;


