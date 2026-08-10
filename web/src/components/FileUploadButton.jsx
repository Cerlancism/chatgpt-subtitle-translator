import { Button } from "@nextui-org/react";

export const FileUploadButton = ({ label, accept, onFileSelect }) => {
  // Function to handle file selection
  const handleFileInput = (e) => {
    // Get the selected file
    const file = e.target.files[0];
    if (!file) {
      return;
    }
    // Call the passed in function
    onFileSelect(file);
    // Allow selecting the same file again
    e.target.value = "";
  };

  return (
    <div>
      <input
        type="file"
        id="file-input"
        accept={accept}
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
