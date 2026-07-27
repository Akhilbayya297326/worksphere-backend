// Middleware to protect routes based on role (RBAC)
const requireManager = (req, res, next) => {
  // In a production app, this would be extracted from a verified JWT token.
  // For the hackathon demo, we simulate this via a secure header passed from the frontend.
  const userRole = req.headers['x-user-role'];
  
  if (userRole !== 'Manager') {
    return res.status(403).json({ 
      success: false, 
      error: 'Access Denied: Enterprise Manager clearance required to perform this action.' 
    });
  }
  
  // If they are a manager, allow the request to proceed to the route
  next();
};

module.exports = { requireManager };