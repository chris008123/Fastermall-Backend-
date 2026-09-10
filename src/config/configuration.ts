export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  // Used once to create your very first admin via POST /staff/bootstrap-admin.
  // Set this to a long random string in your .env / Render environment variables.
  adminBootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
});
