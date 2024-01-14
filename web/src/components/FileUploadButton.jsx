import { Button } from "@nextui-org/react";

export const FileUploadButton = ({ label, onFileSelect }) => {
  // Function to handle file selection
  const handleFileInput = (e) => {
    // Get the selected file
    const file = e.target.files[0];
    // Call the passed in function
    onFileSelect(file);
  };

  return (
    <div>
      <input
        type="file"
        id="file-input"
        style={{ display: 'none' }}
        onChange={handleFileInput}
      />
      <label htmlFor="file-input">
        <Button as="span" color="primary">
          {label}
        </Button>
      </label>
    </div>
  );
};
